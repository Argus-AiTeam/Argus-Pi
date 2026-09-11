import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, ImageContent, Model, TextContent } from "@earendil-works/pi-ai";
import { constants } from "fs";
import { access as fsAccess, readFile as fsReadFile } from "fs/promises";
import { extname } from "path";
import { type Static, Type } from "typebox";
import { getResolvedPDFJS } from "unpdf";
import { raceWithAbortSignal } from "../../utils/abort.ts";
import { processImage } from "../../utils/image-process.ts";
import { detectSupportedImageMimeTypeFromFile } from "../../utils/mime.ts";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { readNotebookCells } from "./notebook-read.ts";
import { resolveReadPathAsync } from "./path-utils.ts";
import { parseReadRange } from "./read-range.ts";
import { readRenderers } from "./renderers/read.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult, truncateHead } from "./truncate.ts";

const readSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
	pages: Type.Optional(Type.String({ description: "PDF pages to extract (1-indexed), e.g. '3' or '3-5'. PDF only." })),
	cells: Type.Optional(
		Type.String({
			description:
				"Notebook cells (1-indexed), e.g. '3' or '3-5'. Start with '1' to discover the count. nbformat 4 only.",
		}),
	),
	includeOutputs: Type.Optional(
		Type.Boolean({
			description:
				"With cells, include stored text/error outputs (default: false). Does not execute code or render images.",
		}),
	),
});

export const readToolSystemPromptContribution = {
	snippet: "Read file contents",
	guidelines: ["Use read to examine files instead of cat or sed."],
} as const;

export type ReadToolInput = Static<typeof readSchema>;

export interface ReadToolDetails {
	truncation?: TruncationResult;
}

/**
 * Pluggable operations for the read tool.
 * Override these to delegate file reading to remote systems (for example SSH).
 */
export interface ReadOperations {
	/** Read file contents as a Buffer */
	readFile: (absolutePath: string) => Promise<Buffer>;
	/** Check if file is readable (throw if not) */
	access: (absolutePath: string) => Promise<void>;
	/** Detect image MIME type, return null or undefined for non-images */
	detectImageMimeType?: (absolutePath: string) => Promise<string | null | undefined>;
}

const defaultReadOperations: ReadOperations = {
	readFile: (path) => fsReadFile(path),
	access: (path) => fsAccess(path, constants.R_OK),
	detectImageMimeType: detectSupportedImageMimeTypeFromFile,
};

export interface ReadToolOptions {
	/** Whether to auto-resize images to 2000x2000 max. Default: true */
	autoResizeImages?: boolean;
	/** Custom operations for file reading. Default: local filesystem */
	operations?: ReadOperations;
}

function getNonVisionImageNote(model: Model<Api> | undefined): string | undefined {
	if (!model || model.input.includes("image")) {
		return undefined;
	}
	return "[Current model does not support images. The image will be omitted from this request.]";
}

async function readPdfText(buffer: Buffer, signal?: AbortSignal, pageRange?: string): Promise<string> {
	const range = pageRange === undefined ? undefined : parseReadRange(pageRange, "PDF pages");
	const { getDocument } = await getResolvedPDFJS();
	if (signal?.aborted) throw new Error("Operation aborted");
	// Reject damaged content instead of returning partial evidence, and keep parser logs out of RPC stdout.
	const task = getDocument({ data: new Uint8Array(buffer), stopAtErrors: true, verbosity: 0, useSystemFonts: true });
	try {
		const pdf = await raceWithAbortSignal(task.promise, signal);
		if ((await raceWithAbortSignal(pdf.getPermissions(), signal)) !== null) {
			throw new Error("Encrypted PDFs are not supported.");
		}
		const [firstPage, lastPage] = range ?? [1, pdf.numPages];
		if (firstPage > lastPage || lastPage > pdf.numPages) {
			throw new Error(`Requested PDF pages '${pageRange}' are outside the valid range 1-${pdf.numPages}.`);
		}
		const pages: string[] = [];
		let hasText = false;
		for (let pageNumber = firstPage; pageNumber <= lastPage; pageNumber++) {
			if (signal?.aborted) throw new Error("Operation aborted");
			const page = await raceWithAbortSignal(pdf.getPage(pageNumber), signal);
			const content = await raceWithAbortSignal(page.getTextContent(), signal);
			const text = content.items
				.map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : "") : ""))
				.join("")
				.trim();
			hasText ||= text.length > 0;
			pages.push(
				`[Page ${pageNumber} of ${pdf.numPages}]\n${text || "[No extractable text on this page; it may be blank or scanned. OCR and visual verification are not supported.]"}`,
			);
			page.cleanup();
		}
		if (!hasText) {
			throw new Error(
				pageRange === undefined
					? "PDF has no extractable text. It may be blank or scanned; OCR is not supported."
					: `Selected PDF pages '${pageRange}' have no extractable text. They may be blank or scanned; OCR is not supported.`,
			);
		}
		return pages.join("\n\n");
	} catch (error) {
		if (error instanceof Error && error.name === "PasswordException") {
			throw new Error("Cannot read encrypted PDF: password-protected PDFs are not supported.", { cause: error });
		}
		throw new Error(`Cannot extract PDF text: ${error instanceof Error ? error.message : String(error)}`, {
			cause: error,
		});
	} finally {
		await task.destroy();
	}
}

export function createReadToolDefinition(
	cwd: string,
	options?: ReadToolOptions,
): ToolDefinition<typeof readSchema, ReadToolDetails | undefined> {
	const autoResizeImages = options?.autoResizeImages ?? true;
	const ops = options?.operations ?? defaultReadOperations;
	return {
		name: "read",
		label: "read",
		description: `Read text files, PDF text, notebooks, and images (jpg, png, gif, webp, bmp). Images are attachments. PDFs return page-marked text, not visual verification; use pages (e.g. "3-5") to select pages. Encrypted or entirely textless PDF selections error. For nbformat 4 notebooks, cells selects cell source, saved execution counts and output inventory; includeOutputs=true adds saved text/error outputs, not image rendering or code execution. Omit cells for raw JSON. Saved outputs do not prove a fresh run. pages and cells cannot be combined. Text is limited to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB. offset/limit count lines within the selected view; retain selection options when continuing.`,
		promptSnippet: readToolSystemPromptContribution.snippet,
		promptGuidelines: [...readToolSystemPromptContribution.guidelines],
		parameters: readSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		async execute(
			_toolCallId,
			{ path, offset, limit, pages, cells, includeOutputs }: ReadToolInput,
			signal?: AbortSignal,
			_onUpdate?,
			ctx?: ExtensionContext,
		) {
			return new Promise<{ content: (TextContent | ImageContent)[]; details: ReadToolDetails | undefined }>(
				(resolve, reject) => {
					if (signal?.aborted) {
						reject(new Error("Operation aborted"));
						return;
					}
					let aborted = false;
					const onAbort = () => {
						aborted = true;
						reject(new Error("Operation aborted"));
					};
					signal?.addEventListener("abort", onAbort, { once: true });

					(async () => {
						try {
							if (pages !== undefined && cells !== undefined)
								throw new Error("pages and cells cannot be combined.");
							if (includeOutputs !== undefined && cells === undefined) {
								throw new Error("includeOutputs requires a notebook cells selection.");
							}
							const absolutePath = await resolveReadPathAsync(path, ctx?.cwd || cwd);
							if (aborted) return;
							// Check if file exists and is readable.
							await ops.access(absolutePath);
							if (aborted) return;
							const mimeType = ops.detectImageMimeType ? await ops.detectImageMimeType(absolutePath) : undefined;
							let content: (TextContent | ImageContent)[];
							let details: ReadToolDetails | undefined;
							const nonVisionImageNote = getNonVisionImageNote(ctx?.model);
							if (mimeType) {
								if (cells !== undefined)
									throw new Error("The cells parameter is only supported for notebooks.");
								if (pages !== undefined)
									throw new Error("The pages parameter is only supported for PDF files.");
								// Read image as binary.
								const buffer = await ops.readFile(absolutePath);
								const processed = await processImage(buffer, mimeType, { autoResizeImages });
								if (!processed.ok) {
									let textNote = `Read image file [${mimeType}]\n${processed.message}`;
									if (nonVisionImageNote) textNote += `\n${nonVisionImageNote}`;
									content = [{ type: "text", text: textNote }];
								} else {
									let textNote = `Read image file [${processed.mimeType}]`;
									if (processed.hints.length > 0) textNote += `\n${processed.hints.join("\n")}`;
									if (nonVisionImageNote) textNote += `\n${nonVisionImageNote}`;
									content = [
										{ type: "text", text: textNote },
										{ type: "image", data: processed.data, mimeType: processed.mimeType },
									];
								}
							} else {
								const buffer = await ops.readFile(absolutePath);
								if (aborted) return;
								const isPdf =
									buffer.subarray(0, 5).toString("ascii") === "%PDF-" ||
									extname(absolutePath).toLowerCase() === ".pdf";
								if (pages !== undefined && !isPdf) {
									throw new Error("The pages parameter is only supported for PDF files.");
								}
								if (cells !== undefined && isPdf)
									throw new Error("The cells parameter is only supported for notebooks.");
								const textContent = isPdf
									? await readPdfText(buffer, signal, pages)
									: cells !== undefined
										? readNotebookCells(buffer.toString("utf-8"), cells, includeOutputs ?? false)
										: buffer.toString("utf-8");
								if (aborted) return;
								const allLines = textContent.split("\n");
								const totalFileLines = allLines.length;
								// Apply offset if specified. Convert from 1-indexed input to 0-indexed array access.
								const startLine = offset ? Math.max(0, offset - 1) : 0;
								const startLineDisplay = startLine + 1;
								// Check if offset is out of bounds.
								if (startLine >= allLines.length) {
									throw new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`);
								}
								let selectedContent: string;
								let userLimitedLines: number | undefined;
								// If limit is specified by the user, honor it first. Otherwise truncateHead decides.
								if (limit !== undefined) {
									const endLine = Math.min(startLine + limit, allLines.length);
									selectedContent = allLines.slice(startLine, endLine).join("\n");
									userLimitedLines = endLine - startLine;
								} else {
									selectedContent = allLines.slice(startLine).join("\n");
								}
								// Apply truncation, respecting both line and byte limits.
								const truncation = truncateHead(selectedContent);
								const readSelection =
									pages !== undefined
										? `, pages="${pages}"`
										: cells !== undefined
											? `, cells="${cells}"${includeOutputs ? ", includeOutputs=true" : ""}`
											: "";
								let outputText: string;
								if (truncation.firstLineExceedsLimit) {
									const firstLineSize = formatSize(Buffer.byteLength(allLines[startLine], "utf-8"));
									outputText =
										isPdf || cells !== undefined
											? `[${isPdf ? "Extracted PDF" : "Notebook view"} line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit and cannot be displayed by read.]`
											: `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`;
									details = { truncation };
								} else if (truncation.truncated) {
									// Truncation occurred. Build an actionable continuation notice.
									const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
									const nextOffset = endLineDisplay + 1;
									outputText = truncation.content;
									if (truncation.truncatedBy === "lines") {
										outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset}${readSelection} to continue.]`;
									} else {
										outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset}${readSelection} to continue.]`;
									}
									details = { truncation };
								} else if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
									// User-specified limit stopped early, but the file still has more content.
									const remaining = allLines.length - (startLine + userLimitedLines);
									const nextOffset = startLine + userLimitedLines + 1;
									outputText = `${truncation.content}\n\n[${remaining} more lines in ${cells === undefined ? "file" : "view"}. Use offset=${nextOffset}${readSelection} to continue.]`;
								} else {
									// No truncation and no remaining user-limited content.
									outputText = truncation.content;
								}
								if (isPdf) {
									const selection = pages === undefined ? "" : ` Selected PDF pages: ${pages}.`;
									outputText = `[PDF text extraction only; not visual verification of images, figures, or layout.${selection} offset/limit count the extracted text lines, including page markers.]\n\n${outputText}`;
								} else if (cells !== undefined) {
									outputText = `[Notebook cell view: cells ${cells}; includeOutputs=${includeOutputs ?? false}. No code was executed. Saved outputs and execution counts do not prove a fresh run or correctness. offset/limit count view lines, not raw JSON lines. Omit cells for raw JSON.]\n\n${outputText}`;
								}
								content = [{ type: "text", text: outputText }];
							}

							if (aborted) return;
							signal?.removeEventListener("abort", onAbort);
							resolve({ content, details });
						} catch (error: any) {
							signal?.removeEventListener("abort", onAbort);
							if (!aborted) reject(error);
						}
					})();
				},
			);
		},
		...readRenderers,
	};
}

export function createReadTool(cwd: string, options?: ReadToolOptions): AgentTool<typeof readSchema> {
	return wrapToolDefinition(createReadToolDefinition(cwd, options));
}
