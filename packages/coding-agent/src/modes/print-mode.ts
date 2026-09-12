/**
 * Print mode (single-shot): Send prompts, output result, exit.
 *
 * Used for:
 * - `pi -p "prompt"` - text output
 * - `pi --mode json "prompt"` - JSON event stream
 */

import type { AssistantMessage, AssistantMessageEvent, ImageContent } from "@earendil-works/pi-ai";
import type { AgentSessionRuntime } from "../core/agent-session-runtime.ts";
import { getHarnessProfile } from "../core/harness-profile.ts";
import { flushRawStdout, waitForRawStdoutBackpressure, writeRawStdout } from "../core/output-guard.ts";
import { killTrackedDetachedChildren } from "../utils/shell.ts";
import { type JsonAgentSessionEvent, toJsonEvent } from "./json-event.ts";

type AssistantErrorEvent = Extract<AssistantMessageEvent, { type: "error" }>;
type PrintJsonEvent =
	| JsonAgentSessionEvent
	| { type: "attempt_error"; event: JsonAgentSessionEvent }
	| {
			type: "message_update";
			usage: AssistantMessage["usage"];
			assistantMessageEvent: AssistantErrorEvent & { errorMessage: string };
	  };

/**
 * Options for print mode.
 */
export interface PrintModeOptions {
	/** Output mode: "text" for final response only, "json" for all events */
	mode: "text" | "json";
	/** Array of additional prompts to send after initialMessage */
	messages?: string[];
	/** First message to send (may contain @file content) */
	initialMessage?: string;
	/** Images to attach to the initial message */
	initialImages?: ImageContent[];
}

/**
 * Run in print (single-shot) mode.
 * Sends prompts to the agent and outputs the result.
 */
export async function runPrintMode(runtimeHost: AgentSessionRuntime, options: PrintModeOptions): Promise<number> {
	const { mode, messages = [], initialMessage, initialImages } = options;
	let remainingPrompts = messages.length + (initialMessage ? 1 : 0);
	let argusJson = false;
	let exitCode = 0;
	let pendingError: AssistantErrorEvent | undefined;
	let terminalError: string | undefined;
	let session = runtimeHost.session;
	let unsubscribe: (() => void) | undefined;
	let unsubscribeBackpressure: (() => void) | undefined;
	let disposed = false;
	const signalCleanupHandlers: Array<() => void> = [];
	const writeJsonEvent = (event: PrintJsonEvent): void => {
		writeRawStdout(`${JSON.stringify(event)}\n`);
	};

	const disposeRuntime = async (): Promise<void> => {
		if (disposed) return;
		disposed = true;
		unsubscribe?.();
		unsubscribeBackpressure?.();
		await runtimeHost.dispose();
	};

	const registerSignalHandlers = (): void => {
		const signals: NodeJS.Signals[] = ["SIGTERM"];
		if (process.platform !== "win32") {
			signals.push("SIGHUP");
		}

		for (const signal of signals) {
			const handler = () => {
				killTrackedDetachedChildren();
				void disposeRuntime().finally(() => {
					process.exit(signal === "SIGHUP" ? 129 : 143);
				});
			};
			process.on(signal, handler);
			signalCleanupHandlers.push(() => process.off(signal, handler));
		}
	};

	registerSignalHandlers();

	runtimeHost.setRebindSession(async () => {
		await rebindSession();
	});

	const rebindSession = async (): Promise<void> => {
		session = runtimeHost.session;
		pendingError = undefined;
		await session.bindExtensions({
			mode: mode === "json" ? "json" : "print",
			commandContextActions: {
				waitForIdle: () => session.waitForIdle(),
				newSession: async (newSessionOptions) => runtimeHost.newSession(newSessionOptions),
				fork: async (entryId, forkOptions) => {
					const result = await runtimeHost.fork(entryId, forkOptions);
					return { cancelled: result.cancelled };
				},
				navigateTree: async (targetId, navigateOptions) => {
					const result = await session.navigateTree(targetId, {
						summarize: navigateOptions?.summarize,
						customInstructions: navigateOptions?.customInstructions,
						replaceInstructions: navigateOptions?.replaceInstructions,
						label: navigateOptions?.label,
					});
					return { cancelled: result.cancelled };
				},
				switchSession: async (sessionPath, switchOptions) => {
					return runtimeHost.switchSession(sessionPath, switchOptions);
				},
				reload: async () => {
					await session.reload();
				},
			},
			onError: (err) => {
				console.error(`Extension error (${err.extensionPath}): ${err.error}`);
			},
		});

		unsubscribe?.();
		unsubscribeBackpressure?.();
		unsubscribe = session.subscribe((event) => {
			let attemptError: AssistantErrorEvent | undefined;
			if (event.type === "message_update" && event.assistantMessageEvent.type === "error") {
				attemptError = event.assistantMessageEvent;
			} else if (event.type === "message_end" && event.message.role === "assistant") {
				const reason = event.message.stopReason;
				if (reason === "error" || reason === "aborted") {
					attemptError = { type: "error", reason, error: event.message };
				} else if (reason !== "pending") {
					pendingError = undefined;
				}
			}
			if (attemptError) pendingError = attemptError;
			if (event.type === "auto_retry_end" && !event.success) {
				terminalError = event.finalError || "Pi retry did not complete.";
			}
			if (event.type === "agent_settled" && pendingError && remainingPrompts === 0) {
				terminalError ??= pendingError.error.errorMessage || `Request ${pendingError.reason}`;
				if (argusJson) {
					writeJsonEvent({
						type: "message_update",
						usage: pendingError.error.usage,
						assistantMessageEvent: { ...pendingError, errorMessage: terminalError },
					});
				}
			}
			if (mode === "json") {
				if (argusJson && attemptError) {
					// Failed attempts remain diagnostic until the session settles, not until a model says "done".
					writeJsonEvent({ type: "attempt_error", event: toJsonEvent(event) });
					if (event.type === "message_end") {
						// Preserve one usage/turn receipt per provider attempt, without accepting failed partial prose.
						writeJsonEvent({
							type: "message_end",
							message: { ...attemptError.error, content: [], stopReason: "pending" },
						});
					}
				} else {
					writeJsonEvent(toJsonEvent(event));
				}
			}
		});
		unsubscribeBackpressure =
			mode === "json"
				? session.agent.subscribe(async () => {
						await waitForRawStdoutBackpressure();
					})
				: undefined;
	};

	try {
		argusJson = mode === "json" && getHarnessProfile() === "argus";
		if (mode === "json") {
			const header = session.sessionManager.getHeader();
			if (header) {
				writeRawStdout(`${JSON.stringify(header)}\n`);
			}
		}

		await rebindSession();

		if (initialMessage) {
			remainingPrompts--;
			await session.prompt(initialMessage, { images: initialImages });
		}

		for (const message of messages) {
			pendingError = undefined;
			terminalError = undefined;
			remainingPrompts--;
			await session.prompt(message);
		}

		const lastMessage = session.state.messages.at(-1);
		if (lastMessage?.role === "assistant") {
			if (lastMessage.stopReason === "error" || lastMessage.stopReason === "aborted") {
				terminalError ??= lastMessage.errorMessage || `Request ${lastMessage.stopReason}`;
			} else if (mode === "text") {
				for (const content of lastMessage.content) {
					if (content.type === "text") {
						writeRawStdout(`${content.text}\n`);
					}
				}
			}
		}
		if (terminalError) {
			console.error(terminalError);
			exitCode = 1;
		}

		return exitCode;
	} catch (error: unknown) {
		console.error(error instanceof Error ? error.message : String(error));
		return 1;
	} finally {
		for (const cleanup of signalCleanupHandlers) {
			cleanup();
		}
		await disposeRuntime();
		await flushRawStdout();
	}
}
