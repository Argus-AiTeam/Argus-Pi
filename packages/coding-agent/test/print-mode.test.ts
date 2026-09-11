import type { AssistantMessage, ImageContent } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import * as outputGuard from "../src/core/output-guard.ts";
import type { SessionShutdownEvent } from "../src/index.ts";
import { toJsonEvent } from "../src/modes/json-event.ts";
import { runPrintMode } from "../src/modes/print-mode.ts";

type EmitEvent = SessionShutdownEvent;

type FakeExtensionRunner = {
	hasHandlers: (eventType: string) => boolean;
	emit: ReturnType<typeof vi.fn<(event: EmitEvent) => Promise<void>>>;
};

type FakeSession = {
	sessionManager: { getHeader: () => object | undefined };
	agent: { waitForIdle: () => Promise<void>; subscribe: ReturnType<typeof vi.fn> };
	state: { messages: AssistantMessage[] };
	extensionRunner: FakeExtensionRunner;
	bindExtensions: ReturnType<typeof vi.fn>;
	subscribe: ReturnType<typeof vi.fn<(listener: (event: AgentSessionEvent) => void) => () => void>>;
	prompt: ReturnType<typeof vi.fn>;
	reload: ReturnType<typeof vi.fn>;
};

type FakeRuntimeHost = {
	session: FakeSession;
	newSession: ReturnType<typeof vi.fn>;
	fork: ReturnType<typeof vi.fn>;
	switchSession: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
	setRebindSession: ReturnType<typeof vi.fn>;
};

function createAssistantMessage(options?: {
	text?: string;
	stopReason?: AssistantMessage["stopReason"];
	errorMessage?: string;
}): AssistantMessage {
	return {
		role: "assistant",
		content: options?.text ? [{ type: "text", text: options.text }] : [],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: options?.stopReason ?? "stop",
		errorMessage: options?.errorMessage,
		timestamp: Date.now(),
	};
}

function createRuntimeHost(assistantMessage: AssistantMessage): FakeRuntimeHost {
	const extensionRunner: FakeExtensionRunner = {
		hasHandlers: (eventType: string) => eventType === "session_shutdown",
		emit: vi.fn(async () => {}),
	};

	const state = { messages: [assistantMessage] };

	const session: FakeSession = {
		sessionManager: { getHeader: () => undefined },
		agent: { waitForIdle: async () => {}, subscribe: vi.fn(() => () => {}) },
		state,
		extensionRunner,
		bindExtensions: vi.fn(async () => {}),
		subscribe: vi.fn((_listener: (event: AgentSessionEvent) => void) => () => {}),
		prompt: vi.fn(async () => {}),
		reload: vi.fn(async () => {}),
	};

	return {
		session,
		newSession: vi.fn(async () => undefined),
		fork: vi.fn(async () => ({ selectedText: "" })),
		switchSession: vi.fn(async () => undefined),
		dispose: vi.fn(async () => {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		}),
		setRebindSession: vi.fn(),
	};
}

beforeEach(() => vi.stubEnv("PI_HARNESS_PROFILE", "argus"));
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

async function runEventSequence(
	events: AgentSessionEvent[],
	finalMessage: AssistantMessage,
	options: { emptyState?: boolean; profile?: "argus" | "stock" } = {},
) {
	vi.stubEnv("PI_HARNESS_PROFILE", options.profile ?? "argus");
	const runtimeHost = createRuntimeHost(finalMessage);
	const writes = vi.spyOn(outputGuard, "writeRawStdout").mockImplementation(() => {});
	const errors = vi.spyOn(console, "error").mockImplementation(() => {});
	runtimeHost.session.prompt.mockImplementation(async () => {
		if (options.emptyState) runtimeHost.session.state.messages = [];
		const listener = runtimeHost.session.subscribe.mock.calls[0][0];
		for (const event of events) listener(event);
	});
	const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
		mode: "json",
		initialMessage: "fixture",
	});
	const output: Record<string, unknown>[] = writes.mock.calls.map(([line]) => JSON.parse(line));
	return { exitCode, output, errors, runtimeHost };
}

describe("runPrintMode", () => {
	it("emits session_shutdown in text mode", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const { session } = runtimeHost;
		const images: ImageContent[] = [{ type: "image", mimeType: "image/png", data: "abc" }];

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			initialMessage: "Say done",
			initialImages: images,
		});

		expect(exitCode).toBe(0);
		expect(session.prompt).toHaveBeenCalledWith("Say done", { images });
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});

	it("emits session_shutdown in json mode", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const { session } = runtimeHost;

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "json",
			messages: ["hello"],
		});

		expect(exitCode).toBe(0);
		expect(session.prompt).toHaveBeenCalledWith("hello");
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});

	it.each([
		{ mode: "text", stopReason: "error" },
		{ mode: "json", stopReason: "error" },
		{ mode: "text", stopReason: "aborted" },
		{ mode: "json", stopReason: "aborted" },
	] as const)("returns non-zero for $stopReason in $mode mode", async ({ mode, stopReason }) => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ stopReason, errorMessage: "provider failure" }));
		const { session } = runtimeHost;
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode,
		});

		expect(exitCode).toBe(1);
		expect(errorSpy).toHaveBeenCalledWith("provider failure");
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});

	it("keeps failed-attempt diagnostics and usage without making successful recovery terminally fail", async () => {
		const failed = createAssistantMessage({
			text: "MILESTONE_STATUS=done",
			stopReason: "error",
			errorMessage: "overloaded_error",
		});
		failed.usage.input = 11;
		failed.usage.output = 3;
		const recovered = createAssistantMessage({ text: "recovered" });
		recovered.usage.input = 17;
		recovered.usage.output = 5;
		const streamingError: AgentSessionEvent = {
			type: "message_update",
			message: failed,
			assistantMessageEvent: { type: "error", reason: "error", error: failed },
		};
		const failedEnd: AgentSessionEvent = { type: "message_end", message: failed };
		const recoveredEnd: AgentSessionEvent = { type: "message_end", message: recovered };
		const { exitCode, output, errors } = await runEventSequence(
			[
				streamingError,
				failedEnd,
				{ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1, errorMessage: "overloaded_error" },
				recoveredEnd,
				{ type: "auto_retry_end", success: true, attempt: 1 },
				{ type: "agent_settled" },
			],
			recovered,
		);
		expect(exitCode).toBe(0);
		expect(errors).not.toHaveBeenCalled();
		expect(output).toContainEqual({ type: "attempt_error", event: toJsonEvent(streamingError) });
		expect(output).toContainEqual({ type: "attempt_error", event: failedEnd });
		expect(output.filter((event) => event.type === "message_end")).toEqual([
			{ type: "message_end", message: { ...failed, content: [], stopReason: "pending" } },
			recoveredEnd,
		]);
		expect(output.some((event) => event.type === "message_update")).toBe(false);
		expect(output.at(-1)).toEqual({ type: "agent_settled" });
		expect(failed.stopReason).toBe("error");
		expect(failed.content).toEqual([{ type: "text", text: "MILESTONE_STATUS=done" }]);
	});

	it.each(["error", "aborted"] as const)(
		"emits terminal %s before settlement without a second usage receipt",
		async (reason) => {
			const failed = createAssistantMessage({ stopReason: reason, errorMessage: "terminal failure" });
			const { output, exitCode } = await runEventSequence(
				[{ type: "message_end", message: failed }, { type: "agent_settled" }],
				failed,
			);
			expect(exitCode).toBe(1);
			expect(output.filter((event) => event.type === "message_end")).toHaveLength(1);
			expect(output.at(-2)).toMatchObject({
				type: "message_update",
				assistantMessageEvent: { type: "error", reason, errorMessage: "terminal failure", error: failed },
			});
			expect(output.at(-1)).toEqual({ type: "agent_settled" });
		},
	);

	it("fails visibly when retry cancellation removes the error message from session state", async () => {
		const failed = createAssistantMessage({ stopReason: "error", errorMessage: "overloaded_error" });
		const { exitCode, errors, output } = await runEventSequence(
			[
				{ type: "message_end", message: failed },
				{ type: "auto_retry_end", success: false, attempt: 1, finalError: "Retry cancelled" },
				{ type: "agent_settled" },
			],
			failed,
			{ emptyState: true },
		);
		expect(exitCode).toBe(1);
		expect(errors).toHaveBeenCalledWith("Retry cancelled");
		expect(output.at(-2)).toMatchObject({
			type: "message_update",
			assistantMessageEvent: { errorMessage: "Retry cancelled" },
		});
	});

	it("does not treat a retry-success flag without a completed assistant message as recovery", async () => {
		const failed = createAssistantMessage({ stopReason: "error", errorMessage: "unresolved failure" });
		const { exitCode } = await runEventSequence(
			[
				{ type: "message_end", message: failed },
				{ type: "auto_retry_end", success: true, attempt: 1 },
				{ type: "agent_settled" },
			],
			createAssistantMessage({ text: "not emitted" }),
		);
		expect(exitCode).toBe(1);
	});

	it("preserves the raw stock JSON event contract", async () => {
		const failed = createAssistantMessage({ stopReason: "error", errorMessage: "stock error" });
		const events: AgentSessionEvent[] = [{ type: "message_end", message: failed }, { type: "agent_settled" }];
		const { exitCode, output } = await runEventSequence(events, failed, { profile: "stock" });
		expect(exitCode).toBe(1);
		expect(output).toEqual(events);
	});

	it("does not alter successful message events", async () => {
		const done = createAssistantMessage({ text: "done" });
		const events: AgentSessionEvent[] = [{ type: "message_end", message: done }, { type: "agent_settled" }];
		const { output, exitCode } = await runEventSequence(events, done);
		expect(exitCode).toBe(0);
		expect(output).toEqual(events);
	});

	it("disposes the runtime and reports an invalid JSON profile before prompting", async () => {
		vi.stubEnv("PI_HARNESS_PROFILE", "typo");
		const host = createRuntimeHost(createAssistantMessage({ text: "unused" }));
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const exitCode = await runPrintMode(host as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "json",
			initialMessage: "not sent",
		});
		expect(exitCode).toBe(1);
		expect(errors).toHaveBeenCalledWith("Unknown PI_HARNESS_PROFILE: typo. Expected stock or argus.");
		expect(host.session.prompt).not.toHaveBeenCalled();
		expect(host.dispose).toHaveBeenCalledOnce();
	});

	it("keeps terminal state scoped to each explicitly supplied prompt", async () => {
		const failed = createAssistantMessage({ stopReason: "error", errorMessage: "first prompt failed" });
		const recovered = createAssistantMessage({ text: "second prompt succeeded" });
		const host = createRuntimeHost(failed);
		vi.spyOn(outputGuard, "writeRawStdout").mockImplementation(() => {});
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		host.session.prompt.mockImplementation(async (prompt: string) => {
			const message = prompt === "first" ? failed : recovered;
			host.session.state.messages = [message];
			const listener = host.session.subscribe.mock.calls[0][0];
			listener({ type: "message_end", message });
			listener({ type: "agent_settled" });
		});
		const exitCode = await runPrintMode(host as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "json",
			messages: ["first", "second"],
		});
		expect(exitCode).toBe(0);
		expect(errors).not.toHaveBeenCalled();
	});
});
