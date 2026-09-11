import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReadTool } from "../src/core/tools/read.ts";

function notebookTool(cells: unknown[]) {
	const data = JSON.stringify({ nbformat: 4, nbformat_minor: 4, metadata: {}, cells }, null, 2);
	return createReadTool(process.cwd(), {
		operations: { access: async () => {}, readFile: async () => Buffer.from(data) },
	});
}

describe("read tool notebook cells", () => {
	afterEach(() => vi.unstubAllEnvs());

	it("shows later validation code without flooding the view with stored training logs", async () => {
		const tool = notebookTool([
			{ cell_type: "markdown", source: ["# Experiment"], metadata: {} },
			{
				cell_type: "code",
				source: ["print('training')"],
				execution_count: 1,
				metadata: {},
				outputs: [{ output_type: "stream", name: "stdout", text: "stored training log\n".repeat(10000) }],
			},
			{
				cell_type: "code",
				source: ["# REQUIRED_VALIDATION_CELL\n", "assert final_metric < 0.1\n"],
				execution_count: null,
				metadata: {},
				outputs: [],
			},
		]);
		const input = { path: "experiment.ipynb", cells: "1-3" };
		const result = await tool.execute("notebook", input);
		const text = result.content.find((part) => part.type === "text")?.text || "";
		expect(text).toContain("REQUIRED_VALIDATION_CELL");
		expect(text).toContain("Saved execution count: null");
		expect(text).toContain("includeOutputs=true");
		expect(text).not.toContain("stored training log");
		expect(result.details).toBeUndefined();
	});

	it("preserves raw JSON, supports BOM input, and never executes or rewrites source", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "notebook-read-"));
		vi.stubEnv("ARGUS_NOTEBOOK_EXECUTED", undefined);
		const text = `\uFEFF${JSON.stringify({
			nbformat: 4,
			nbformat_minor: 4,
			metadata: {},
			cells: [
				{
					cell_type: "code",
					source: "process.env.ARGUS_NOTEBOOK_EXECUTED = 'yes'",
					execution_count: null,
					outputs: [],
					metadata: {},
				},
			],
		})}`;
		const path = join(cwd, "experiment.ipynb");
		try {
			await writeFile(path, text);
			const tool = createReadTool(cwd);
			const raw = await tool.execute("raw", { path });
			expect(raw.content[0]).toMatchObject({ type: "text", text });
			const selected = await tool.execute("cells", { path, cells: "1" });
			expect(selected.content[0]).toMatchObject({ text: expect.stringContaining("No code was executed") });
			expect(process.env.ARGUS_NOTEBOOK_EXECUTED).toBeUndefined();
			expect(await readFile(path, "utf8")).toBe(text);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("selects markdown and raw cells while preserving multiline source", async () => {
		const tool = notebookTool([
			{ cell_type: "markdown", source: "unrequested", metadata: {} },
			{ cell_type: "raw", source: ["selected\n", "tail"], metadata: {} },
		]);
		const result = await tool.execute("cells", { path: "book.ipynb", cells: "2" });
		const text = result.content.find((part) => part.type === "text")?.text || "";
		expect(text).toContain("[Cell 2 of 2: raw]");
		expect(text).toContain("selected\ntail");
		expect(text).not.toContain("unrequested");
	});

	it("shows saved text and errors only on request and does not render rich MIME payloads", async () => {
		const tool = notebookTool([
			{
				cell_type: "code",
				source: "value = 42",
				execution_count: 9,
				metadata: {},
				outputs: [
					{ output_type: "stream", name: "stdout", text: ["saved ", "stdout\n"] },
					{ output_type: "stream", name: "stderr", text: "saved stderr" },
					{
						output_type: "error",
						ename: "ValueError",
						evalue: "old failure",
						traceback: ["old trace", "old line"],
					},
					{
						output_type: "execute_result",
						execution_count: 8,
						data: { "text/plain": ["answer", ": 42"], "image/png": "IMAGE_PAYLOAD" },
						metadata: {},
					},
					{ output_type: "display_data", data: { "text/html": "<script>NOT_RENDERED</script>" }, metadata: {} },
				],
			},
		]);
		const result = await tool.execute("outputs", { path: "book.ipynb", cells: "1", includeOutputs: true });
		const text = result.content.find((part) => part.type === "text")?.text || "";
		for (const expected of [
			"saved stdout",
			"saved stderr",
			"old trace\nold line",
			"answer: 42",
			"Saved output execution count: 8",
			"image/png",
			"text/html",
		]) {
			expect(text).toContain(expected);
		}
		expect(text).toContain("Saved outputs and execution counts do not prove a fresh run");
		expect(text).not.toContain("IMAGE_PAYLOAD");
		expect(text).not.toContain("NOT_RENDERED");
		expect(result.content.every((part) => part.type === "text")).toBe(true);
	});

	it("retains cell and output choices when continuing through view lines", async () => {
		const tool = notebookTool([
			{
				cell_type: "code",
				source: "value = 1",
				execution_count: 1,
				metadata: {},
				outputs: [{ output_type: "stream", name: "stdout", text: ["row one\n", "row two\n", "row three\n"] }],
			},
		]);
		const first = await tool.execute("first", { path: "book.ipynb", cells: "1", includeOutputs: true, limit: 10 });
		const text = first.content.find((part) => part.type === "text")?.text || "";
		const continuation = text.match(/Use offset=(\d+), cells="1", includeOutputs=true to continue/);
		if (!continuation) throw new Error("Missing notebook continuation instructions");
		const next = await tool.execute("next", {
			path: "book.ipynb",
			cells: "1",
			includeOutputs: true,
			offset: Number(continuation[1]),
		});
		expect(next.content[0]).toMatchObject({ text: expect.stringContaining("row one\nrow two\nrow three") });
	});

	it.each(["", "0", "-1", "1.5", "1,2", "2", "3-1", "99999999999999999999"])(
		"rejects invalid cell selection %j",
		async (cells) => {
			await expect(
				notebookTool([{ cell_type: "raw", source: "one", metadata: {} }]).execute("invalid", {
					path: "book.ipynb",
					cells,
				}),
			).rejects.toThrow(/notebook cells/);
		},
	);

	it.each([
		{ cell_type: ["code"], source: "not a valid cell type" },
		{ cell_type: "code", source: null, execution_count: null, outputs: [] },
		{ cell_type: "raw", source: ["valid", 1] },
		{ cell_type: "code", source: "", execution_count: -1, outputs: [] },
		{ cell_type: "code", source: "", execution_count: "1", outputs: [] },
		{ cell_type: "code", source: "", execution_count: null, outputs: null },
		{ cell_type: "code", source: "", execution_count: null, outputs: [{ output_type: "unknown" }] },
	])("rejects malformed selected cell data", async (cell) => {
		await expect(notebookTool([cell]).execute("invalid", { path: "book.ipynb", cells: "1" })).rejects.toThrow(
			"Invalid notebook",
		);
	});

	it.each([
		{ output_type: "stream", name: "stdout", text: {} },
		{ output_type: "stream", name: "unknown", text: "text" },
		{ output_type: "display_data", data: [] },
		{ output_type: "execute_result", data: { "text/plain": "value" }, execution_count: "1" },
		{ output_type: "error", ename: "Error", evalue: "old", traceback: [1] },
	])("rejects malformed requested output bodies", async (output) => {
		const tool = notebookTool([{ cell_type: "code", source: "", execution_count: null, outputs: [output] }]);
		await expect(tool.execute("invalid", { path: "book.ipynb", cells: "1", includeOutputs: true })).rejects.toThrow(
			"Invalid notebook",
		);
	});

	it("rejects empty notebooks and incompatible selectors instead of ignoring them", async () => {
		const tool = notebookTool([]);
		await expect(tool.execute("empty", { path: "book.ipynb", cells: "1" })).rejects.toThrow("contains no cells");
		await expect(tool.execute("mixed", { path: "book.ipynb", cells: "1", pages: "1" })).rejects.toThrow(
			"cannot be combined",
		);
		await expect(tool.execute("outputs", { path: "book.ipynb", includeOutputs: false })).rejects.toThrow(
			"requires a notebook cells selection",
		);
	});

	it.each(["not JSON", '{"nbformat":3,"cells":[]}', '{"nbformat":4,"cells":{}}'])(
		"rejects malformed or unsupported notebook roots",
		async (data) => {
			const tool = createReadTool(process.cwd(), {
				operations: { access: async () => {}, readFile: async () => Buffer.from(data) },
			});
			await expect(tool.execute("invalid", { path: "book.ipynb", cells: "1" })).rejects.toThrow();
		},
	);

	it("does not validate or show unselected cell bodies", async () => {
		const tool = notebookTool([{ cell_type: "raw", source: "selected", metadata: {} }, null]);
		const result = await tool.execute("selected", { path: "book.ipynb", cells: "1" });
		expect(result.content[0]).toMatchObject({ text: expect.stringContaining("selected") });
	});

	it("rejects notebook selectors on PDFs and images without silently reading a different view", async () => {
		const pdf = createReadTool(process.cwd(), {
			operations: { access: async () => {}, readFile: async () => Buffer.from("%PDF-1.4\n") },
		});
		await expect(pdf.execute("pdf", { path: "paper.pdf", cells: "1" })).rejects.toThrow(
			"cells parameter is only supported for notebooks",
		);
		const readFile = vi.fn(async () => Buffer.alloc(0));
		const image = createReadTool(process.cwd(), {
			operations: { access: async () => {}, readFile, detectImageMimeType: async () => "image/png" },
		});
		await expect(image.execute("image", { path: "figure.png", cells: "1" })).rejects.toThrow(
			"cells parameter is only supported for notebooks",
		);
		expect(readFile).not.toHaveBeenCalled();
	});
});
