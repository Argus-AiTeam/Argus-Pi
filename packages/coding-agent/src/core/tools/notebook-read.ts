import { stripBom } from "../../utils/text.ts";
import { parseReadRange } from "./read-range.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function multiline(value: unknown, label: string): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value) && value.every((line: unknown) => typeof line === "string")) return value.join("");
	throw new Error(`Invalid notebook ${label}: expected a string or string array.`);
}

function executionCount(value: unknown, label: string): number | null {
	if (value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)) return value;
	throw new Error(`Invalid notebook ${label}: execution_count must be a nonnegative integer or null.`);
}

export function readNotebookCells(text: string, selection: string, includeOutputs: boolean): string {
	const [first, last] = parseReadRange(selection, "notebook cells");
	const notebook: unknown = JSON.parse(stripBom(text));
	if (!isRecord(notebook) || notebook.nbformat !== 4 || !Array.isArray(notebook.cells)) {
		throw new Error("Invalid notebook: expected nbformat 4 and a cells array.");
	}
	const cells: unknown[] = notebook.cells;
	if (cells.length === 0) throw new Error("Notebook contains no cells.");
	if (first > last || last > cells.length) {
		throw new Error(`Requested notebook cells '${selection}' are outside the valid range 1-${cells.length}.`);
	}
	const result: string[] = [];
	for (let number = first; number <= last; number++) {
		const cell = cells[number - 1];
		if (!isRecord(cell) || (cell.cell_type !== "code" && cell.cell_type !== "markdown" && cell.cell_type !== "raw")) {
			throw new Error(`Invalid notebook cell ${number}: expected code, markdown or raw.`);
		}
		const source = multiline(cell.source, `cell ${number} source`);
		result.push(`[Cell ${number} of ${cells.length}: ${cell.cell_type}]`, `Source:\n${source}`);
		if (cell.cell_type !== "code") continue;
		const count = executionCount(cell.execution_count, `cell ${number}`);
		if (!Array.isArray(cell.outputs)) throw new Error(`Invalid notebook cell ${number}: outputs must be an array.`);
		result.push(`Saved execution count: ${count}`);
		const values: unknown[] = cell.outputs;
		const outputs = values.map((value, index) => {
			if (!isRecord(value)) throw new Error(`Invalid notebook cell ${number} output ${index + 1}.`);
			const kind = value.output_type;
			if (kind !== "stream" && kind !== "execute_result" && kind !== "display_data" && kind !== "error") {
				throw new Error(`Invalid notebook cell ${number} output ${index + 1}: unsupported output_type.`);
			}
			return { kind, value, label: `cell ${number} output ${index + 1}` };
		});
		const kinds = [...new Set(outputs.map((output) => output.kind))].join(", ");
		result.push(`Saved outputs: ${outputs.length}${kinds ? ` (${kinds})` : ""}.`);
		if (!includeOutputs) {
			if (outputs.length > 0) result.push("[Output bodies not shown. Use includeOutputs=true to read stored text.]");
			continue;
		}
		for (const { kind, value, label } of outputs) {
			if (kind === "stream") {
				if (value.name !== "stdout" && value.name !== "stderr") {
					throw new Error(`Invalid notebook ${label}: stream name must be stdout or stderr.`);
				}
				result.push(`[Stored ${value.name}]`, multiline(value.text, `${label} text`));
			} else if (kind === "error") {
				if (
					typeof value.ename !== "string" ||
					typeof value.evalue !== "string" ||
					!Array.isArray(value.traceback) ||
					!value.traceback.every((line: unknown) => typeof line === "string")
				) {
					throw new Error(`Invalid notebook ${label}: expected error name, value and traceback.`);
				}
				result.push(
					`[Stored error: ${JSON.stringify(value.ename)}: ${JSON.stringify(value.evalue)}]`,
					value.traceback.join("\n"),
				);
			} else {
				if (!isRecord(value.data)) throw new Error(`Invalid notebook ${label}: data must be a MIME bundle.`);
				if (kind === "execute_result") {
					result.push(`Saved output execution count: ${executionCount(value.execution_count, label)}`);
				}
				const plain = value.data["text/plain"];
				if (plain !== undefined)
					result.push(`[Stored ${kind}: text/plain]`, multiline(plain, `${label} text/plain`));
				else result.push(`[Stored ${kind}: no text/plain output.]`);
				const otherTypes = Object.keys(value.data).filter((mime) => mime !== "text/plain");
				if (otherTypes.length > 0) {
					result.push(`[Stored non-text MIME outputs not rendered: ${JSON.stringify(otherTypes)}]`);
				}
			}
		}
	}
	return result.join("\n\n");
}
