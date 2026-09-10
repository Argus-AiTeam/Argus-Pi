import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { createReadTool } from "../src/core/tools/read.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "../src/core/tools/truncate.ts";

function createPdf(pages: string[][], encrypted = false): Buffer {
	const objects: Buffer[] = [
		Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
		Buffer.from(
			`<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`,
		),
		Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
	];
	for (const [i, lines] of pages.entries()) {
		const width = Math.max(612, ...lines.map((line) => line.length * 12 + 144));
		objects.push(
			Buffer.from(
				`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`,
			),
		);
		const stream = deflateSync(
			`BT /F1 12 Tf 14 TL 72 720 Td ${lines.map((line) => `(${line.replace(/[\\()]/g, "\\$&")}) Tj T*`).join(" ")} ET`,
		);
		objects.push(
			Buffer.concat([
				Buffer.from(`<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`),
				stream,
				Buffer.from("\nendstream"),
			]),
		);
	}
	if (encrypted) {
		// A Standard security dictionary prompts for a password before the content streams are read.
		objects.push(
			Buffer.from(
				`<< /Filter /Standard /V 1 /R 2 /Length 40 /P -4 /O <${"00".repeat(32)}> /U <${"00".repeat(32)}> >>`,
			),
		);
	}
	let pdf = Buffer.from("%PDF-1.4\n");
	const offsets = [0];
	for (const [i, object] of objects.entries()) {
		offsets.push(pdf.length);
		pdf = Buffer.concat([pdf, Buffer.from(`${i + 1} 0 obj\n`), object, Buffer.from("\nendobj\n")]);
	}
	const xref = pdf.length;
	return Buffer.concat([
		pdf,
		Buffer.from(
			`xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets
				.slice(1)
				.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
				.join(
					"",
				)}trailer\n<< /Size ${offsets.length} /Root 1 0 R${encrypted ? ` /Encrypt ${objects.length} 0 R /ID [<00> <00>]` : ""} >>\nstartxref\n${xref}\n%%EOF\n`,
		),
	]);
}

function pdfReadTool(pdf: Buffer) {
	return createReadTool(process.cwd(), {
		operations: {
			access: async () => {},
			readFile: async () => pdf,
		},
	});
}

describe("read tool PDF text", () => {
	it("reads a synthetic PDF through the default filesystem operations", async () => {
		const path = join(import.meta.dirname, ".read-pdf-fixture.pdf");
		try {
			writeFileSync(path, createPdf([["Filesystem paper evidence"]]));
			const result = await createReadTool(process.cwd()).execute("pdf", { path });
			expect(result.content[0]).toMatchObject({
				type: "text",
				text: expect.stringContaining("[Page 1 of 1]\nFilesystem paper evidence"),
			});
		} finally {
			rmSync(path, { force: true });
		}
	});

	it("extracts compressed PDF text with page markers rather than raw UTF-8 bytes", async () => {
		const pdf = createPdf([["Paper title", "First page evidence"], ["Second page evidence"]]);
		const tool = pdfReadTool(pdf);

		const result = await tool.execute("pdf", { path: "paper.pdf" });
		const text = result.content.find((block) => block.type === "text")?.text;

		expect(text).toContain("[Page 1 of 2]\nPaper title\nFirst page evidence");
		expect(text).toContain("[Page 2 of 2]\nSecond page evidence");
		expect(text).toContain("not visual verification");
		expect(text).not.toContain("%PDF-");
		expect(result.content.every((block) => block.type === "text")).toBe(true);
		expect(result.details).toBeUndefined();
	});

	it("uses PDF magic for extensionless input and accepts uppercase PDF extensions", async () => {
		const tool = pdfReadTool(createPdf([["Paper evidence"]]));
		for (const path of ["paper", "paper.PDF"]) {
			const result = await tool.execute("pdf", { path });
			expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Paper evidence") });
		}
	});

	it("applies offset/limit to extracted lines including page markers and retains the extraction caveat", async () => {
		const tool = pdfReadTool(createPdf([["Paper title", "First page evidence"], ["Second page evidence"]]));
		const first = await tool.execute("pdf", { path: "paper.pdf", offset: 2, limit: 2 });
		const firstText = first.content.find((block) => block.type === "text")?.text;
		expect(firstText).toContain("not visual verification");
		expect(firstText).toContain("Paper title\nFirst page evidence");
		expect(firstText).not.toContain("[Page 1 of 2]");
		expect(firstText).not.toContain("Second page evidence");
		expect(firstText).toContain("[3 more lines in file. Use offset=4 to continue.]");

		const second = await tool.execute("pdf", { path: "paper.pdf", offset: 5, limit: 2 });
		const secondText = second.content.find((block) => block.type === "text")?.text;
		expect(secondText).toContain("[Page 2 of 2]\nSecond page evidence");
		expect(secondText).not.toContain("Use offset=");
		await expect(tool.execute("pdf", { path: "paper.pdf", offset: 7 })).rejects.toThrow(
			"Offset 7 is beyond end of file (6 lines total)",
		);
	});

	it("keeps the existing line truncation and continuation policy for extracted text", async () => {
		const pages = Array.from({ length: 40 }, (_, page) =>
			Array.from({ length: 50 }, (_, line) => `p${page + 1} l${line + 1}`),
		);
		const tool = pdfReadTool(createPdf(pages));
		const result = await tool.execute("pdf", { path: "paper.pdf" });
		expect(result.details?.truncation).toMatchObject({
			truncated: true,
			truncatedBy: "lines",
			outputLines: DEFAULT_MAX_LINES,
		});
		const text = result.content.find((block) => block.type === "text")?.text;
		expect(text).toContain(`Use offset=${DEFAULT_MAX_LINES + 1} to continue.`);
		const continuation = await tool.execute("pdf", { path: "paper.pdf", offset: DEFAULT_MAX_LINES + 1 });
		expect(continuation.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("p40 l50") });
		expect(continuation.details).toBeUndefined();
	});

	it("reports oversized extracted lines without suggesting bash on binary PDF bytes", async () => {
		const tool = pdfReadTool(createPdf([["x".repeat(DEFAULT_MAX_BYTES + 1)]]));
		const result = await tool.execute("pdf", { path: "paper.pdf", offset: 2 });
		const text = result.content.find((block) => block.type === "text")?.text;
		expect(result.details?.truncation).toMatchObject({ truncatedBy: "bytes", firstLineExceedsLimit: true });
		expect(text).toContain("cannot be displayed by read");
		expect(text).not.toContain("Use bash");
	});

	it("keeps the existing byte truncation policy for extracted text", async () => {
		const pages = Array.from({ length: 2 }, () => Array.from({ length: 50 }, () => "x".repeat(600)));
		const result = await pdfReadTool(createPdf(pages)).execute("pdf", { path: "paper.pdf" });
		expect(result.details?.truncation).toMatchObject({ truncated: true, truncatedBy: "bytes" });
		expect(result.details?.truncation.outputBytes).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringMatching(/\(50.0KB limit\)\. Use offset=\d+ to continue/),
		});
	});

	it.each([Buffer.from("%PDF-1.4\nbroken"), Buffer.from("not a PDF")])(
		"rejects malformed PDF input rather than returning binary text",
		async (pdf) => {
			await expect(pdfReadTool(pdf).execute("pdf", { path: "broken.pdf" })).rejects.toThrow(
				/Cannot extract PDF text:.*Invalid PDF/i,
			);
		},
	);

	it("rejects a damaged PDF content stream rather than returning partial evidence", async () => {
		const pdf = createPdf([["Paper evidence"]]);
		pdf[pdf.indexOf("stream\n") + "stream\n".length] = 0;
		await expect(pdfReadTool(pdf).execute("pdf", { path: "broken.pdf" })).rejects.toThrow("Cannot extract PDF text:");
	});

	it("reports password-protected PDFs explicitly", async () => {
		const tool = pdfReadTool(createPdf([["Protected paper"]], true));
		await expect(tool.execute("pdf", { path: "encrypted.pdf" })).rejects.toThrow(
			"Cannot read encrypted PDF: password-protected PDFs are not supported.",
		);
	});

	it.each([{ blank: [] }, { blank: ["   "] }])(
		"marks textless pages without discarding evidence on the other pages",
		async ({ blank }) => {
			const tool = pdfReadTool(createPdf([["First page evidence"], blank]));
			const result = await tool.execute("pdf", { path: "paper.pdf" });
			expect(result.content[0]).toMatchObject({
				type: "text",
				text: expect.stringContaining("First page evidence"),
			});
			expect(result.content[0]).toMatchObject({
				text: expect.stringContaining("[Page 2 of 2]\n[No extractable text on this page"),
			});
			await expect(pdfReadTool(createPdf([blank])).execute("pdf", { path: "scanned.pdf" })).rejects.toThrow(
				"PDF has no extractable text",
			);
		},
	);

	it("preserves cancellation before file access", async () => {
		const access = vi.fn();
		const readFile = vi.fn();
		const tool = createReadTool(process.cwd(), { operations: { access, readFile } });
		const controller = new AbortController();
		controller.abort();
		await expect(tool.execute("pdf", { path: "paper.pdf" }, controller.signal)).rejects.toThrow("Operation aborted");
		expect(access).not.toHaveBeenCalled();
		expect(readFile).not.toHaveBeenCalled();
	});

	it("preserves cancellation while reading the PDF bytes", async () => {
		const controller = new AbortController();
		const tool = createReadTool(process.cwd(), {
			operations: {
				access: async () => {},
				readFile: async () => {
					controller.abort();
					return createPdf([["Paper evidence"]]);
				},
			},
		});
		await expect(tool.execute("pdf", { path: "paper.pdf" }, controller.signal)).rejects.toThrow("Operation aborted");
	});
});
