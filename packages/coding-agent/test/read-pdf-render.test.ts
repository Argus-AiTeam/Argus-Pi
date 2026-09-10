import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { getDocsPath } from "../src/config.ts";
import { readRenderers } from "../src/core/tools/renderers/read.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("PDF read call display", () => {
	beforeAll(() => initTheme("dark"));

	it.each([
		{ path: "paper.pdf", pages: "2-3", offset: 2, limit: 3, expected: "paper.pdf [pages 2-3]:2-4" },
		{ path: "paper.pdf", pages: "2", expected: "paper.pdf [pages 2]" },
		{ path: join(getDocsPath(), "paper.pdf"), pages: "2-3", expected: "paper.pdf [pages 2-3]" },
		{ path: "paper.pdf", pages: "2\n\u001b[31mspoof", expected: "paper.pdf [invalid arg]" },
	])("shows the requested page selection for $path", ({ expected, ...args }) => {
		const component = readRenderers.renderCall!(args, theme, {
			args,
			toolCallId: "pdf-read",
			invalidate: () => {},
			lastComponent: undefined,
			state: {},
			cwd: process.cwd(),
			executionStarted: false,
			argsComplete: true,
			isPartial: false,
			expanded: false,
			showImages: false,
			isError: false,
		});
		expect(stripAnsi(component.render(160).join("\n"))).toContain(expected);
	});
});
