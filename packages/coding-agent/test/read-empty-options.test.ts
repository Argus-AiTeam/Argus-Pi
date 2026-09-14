import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createReadTool } from "../src/core/tools/read.ts";

describe("read with unused structured selectors", () => {
	let directory: string;
	beforeAll(() => {
		directory = mkdtempSync(join(tmpdir(), "pi-read-empty-"));
		writeFileSync(join(directory, "notes.md"), "The reviewer can read this file.\n");
	});
	afterAll(() => rmSync(directory, { recursive: true, force: true }));

	it.each([
		{ pages: "", cells: "", includeOutputs: false },
		{ pages: "  ", cells: "\t", includeOutputs: false },
	])("reads plain text with default-valued optional fields: %j", async (selectors) => {
		const result = await createReadTool(directory).execute("read-notes", { path: "notes.md", ...selectors });
		expect(result.content).toEqual([{ type: "text", text: "The reviewer can read this file.\n" }]);
	});

	it("still rejects two actual format selections", async () => {
		await expect(
			createReadTool(directory).execute("conflict", { path: "notes.md", pages: "1", cells: "1" }),
		).rejects.toThrow("pages and cells cannot be combined");
	});

	it("still requires a notebook selection when outputs are requested", async () => {
		await expect(
			createReadTool(directory).execute("outputs", { path: "notes.md", pages: "", cells: "", includeOutputs: true }),
		).rejects.toThrow("includeOutputs requires a notebook cells selection");
	});
});
