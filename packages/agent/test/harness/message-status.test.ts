import { describe, expect, it } from "vitest";
import { type BashExecutionMessage, bashExecutionToText, convertToLlm } from "../../src/harness/messages.ts";

describe("bash execution context status", () => {
	it.each([
		{ signal: "SIGTERM", cancelled: false, expected: "terminated by signal SIGTERM" },
		{ signal: undefined, cancelled: false, expected: "terminated without an exit code" },
		{ signal: "SIGTERM", cancelled: true, expected: "command cancelled" },
	])("preserves $expected in model context", ({ signal, cancelled, expected }) => {
		const message: BashExecutionMessage = {
			role: "bashExecution",
			command: "controlled command",
			output: "partial output",
			exitCode: undefined,
			signal,
			cancelled,
			truncated: false,
			timestamp: 0,
		};
		expect(bashExecutionToText(message)).toContain(expected);
		expect(convertToLlm([message])).toMatchObject([
			{ role: "user", content: [{ type: "text", text: expect.stringContaining(expected) }] },
		]);
	});
});
