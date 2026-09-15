import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFindTool } from "../src/core/tools/find.ts";
import { createGrepTool } from "../src/core/tools/grep.ts";
import { SearchErrors } from "../src/core/tools/search-errors.ts";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("child_process", () => ({ spawn: mocks.spawn }));
vi.mock("../src/utils/tools-manager.ts", () => ({ ensureTool: async (name: string) => name }));

describe("bounded search stderr", () => {
	beforeEach(() => mocks.spawn.mockReset());

	it("preserves UTF-8 across chunks and omits an incomplete character at the cap", () => {
		const errors = new SearchErrors();
		const bytes = Buffer.from("文".repeat(2000));
		for (let i = 0; i < bytes.length; i++) errors.append(bytes.subarray(i, i + 1));
		const message = errors.message("fallback");
		expect(message).toContain("first 4096 of 6000 bytes");
		expect(message).not.toContain("�");
		expect(message.startsWith("文".repeat(1365))).toBe(true);
	});

	it("preserves complete small errors and supplies a fallback for empty stderr", () => {
		const errors = new SearchErrors();
		expect(errors.message("exit 2")).toBe("exit 2");
		errors.append(Buffer.from("  Invalid expression 文\n"));
		expect(errors.message("exit 2")).toBe("Invalid expression 文");
	});

	it.each(["grep", "find"])("%s rejects with bounded diagnostics for a huge first line", async (name) => {
		mocks.spawn.mockImplementation(() => {
			const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
			setTimeout(() => {
				child.stderr.end(Buffer.from("Permission denied ".repeat(100000)));
				child.stdout.end();
				child.emit("close", 2);
			}, 0);
			return child;
		});
		const tool = name === "grep" ? createGrepTool(process.cwd()) : createFindTool(process.cwd());
		const error = await tool.execute("search", { pattern: "source" }).catch((error: Error) => error);
		expect(error).toBeInstanceOf(Error);
		if (!(error instanceof Error)) throw new Error("Expected failed search");
		expect(Buffer.byteLength(error.message)).toBeLessThan(4352);
		expect(error.message).toContain("Permission denied");
		expect(error.message).toContain("Search incomplete");
		expect(error.message).toContain("1800000 bytes");
	});

	it.each(["grep", "find"])("%s still distinguishes an empty successful search from failure", async (name) => {
		mocks.spawn.mockImplementation(() => {
			const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
			setTimeout(() => {
				child.stdout.end();
				child.stderr.end();
				child.emit("close", name === "grep" ? 1 : 0);
			}, 0);
			return child;
		});
		const tool = name === "grep" ? createGrepTool(process.cwd()) : createFindTool(process.cwd());
		const result = await tool.execute("search", { pattern: "source" });
		expect(result.content).toEqual([
			{ type: "text", text: name === "grep" ? "No matches found" : "No files found matching pattern" },
		]);
	});

	it.each(["grep", "find"])("%s still honors cancellation before starting", async (name) => {
		const tool = name === "grep" ? createGrepTool(process.cwd()) : createFindTool(process.cwd());
		await expect(tool.execute("search", { pattern: "source" }, AbortSignal.abort())).rejects.toThrow(
			"Operation aborted",
		);
		expect(mocks.spawn).not.toHaveBeenCalled();
	});
});
