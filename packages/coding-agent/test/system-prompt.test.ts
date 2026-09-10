import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Skill } from "../src/core/skills.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import { buildSystemPrompt } from "../src/core/system-prompt.ts";

const testSkill: Skill = {
	name: "test-skill",
	description: "A test skill.",
	filePath: "/skills/test-skill/SKILL.md",
	baseDir: "/skills/test-skill",
	sourceInfo: createSyntheticSourceInfo("/skills/test-skill/SKILL.md", { source: "test" }),
	disableModelInvocation: false,
};

describe("buildSystemPrompt", () => {
	beforeEach(() => vi.stubEnv("PI_HARNESS_PROFILE", "stock"));
	afterEach(() => vi.unstubAllEnvs());

	describe("Argus harness profile", () => {
		test("defaults to the Argus profile without caller configuration", () => {
			vi.stubEnv("PI_HARNESS_PROFILE", undefined);
			const automatic = buildSystemPrompt({ cwd: "/workspace" });
			vi.stubEnv("PI_HARNESS_PROFILE", "argus");
			expect(buildSystemPrompt({ cwd: "/workspace" })).toBe(automatic);
			expect(automatic).toContain("Follow the assigned role");
			expect(automatic).not.toContain("expert coding assistant");
		});

		test("restores the upstream persona and documentation with the stock profile", () => {
			const prompt = buildSystemPrompt({ cwd: "/workspace" });
			expect(prompt).toContain("expert coding assistant");
			expect(prompt).toContain("TUI components");
		});

		test("uses the assigned role without claiming unavailable execution tools", () => {
			vi.stubEnv("PI_HARNESS_PROFILE", "argus");
			const prompt = buildSystemPrompt({
				cwd: "/workspace",
				selectedTools: ["read"],
				toolSnippets: { read: "Read file contents", write: "Write files" },
			});
			expect(prompt).toContain("Follow the assigned role");
			expect(prompt).toContain("- read: Read file contents");
			expect(prompt).not.toContain("- write:");
			expect(prompt).not.toContain("executing commands, editing code");
			expect(prompt).toContain("without observed evidence");
		});

		test("preserves context, skills, tool guidance, and handoff requirements", () => {
			const options = {
				cwd: "/workspace",
				selectedTools: ["read"],
				skills: [testSkill],
				contextFiles: [{ path: "/workspace/AGENTS.md", content: "Do not publish." }],
				promptGuidelines: ["Use read for files."],
				appendSystemPrompt: "Return the requested decision fields.",
			};
			vi.stubEnv("PI_HARNESS_PROFILE", "stock");
			const stock = buildSystemPrompt(options);
			vi.stubEnv("PI_HARNESS_PROFILE", "argus");
			const prompt = buildSystemPrompt(options);
			for (const text of [
				"Do not publish.",
				"Use read for files.",
				"Return the requested decision fields.",
				"<name>test-skill</name>",
				"Current working directory: /workspace",
			]) {
				expect(prompt).toContain(text);
			}
			expect(prompt.length).toBeLessThan(stock.length);
			expect(prompt).not.toContain("TUI components");
		});

		test("keeps explicitly supplied system prompts authoritative", () => {
			const options = { cwd: "/workspace", customPrompt: "An explicit role.", skills: [testSkill] };
			vi.stubEnv("PI_HARNESS_PROFILE", "stock");
			const stock = buildSystemPrompt(options);
			vi.stubEnv("PI_HARNESS_PROFILE", "argus");
			expect(buildSystemPrompt(options)).toBe(stock);
		});

		test("preserves a no-tools session without advertising tool capabilities", () => {
			vi.stubEnv("PI_HARNESS_PROFILE", "argus");
			const prompt = buildSystemPrompt({ cwd: "/workspace", selectedTools: [], skills: [testSkill] });
			expect(prompt).toContain("Available tools:\n(none)");
			expect(prompt).not.toContain("<available_skills>");
		});

		test("rejects misspelled profiles rather than silently selecting a default", () => {
			vi.stubEnv("PI_HARNESS_PROFILE", "argu");
			expect(() => buildSystemPrompt({ cwd: "/workspace" })).toThrow("Unknown PI_HARNESS_PROFILE");
		});
	});

	describe("empty tools", () => {
		test("shows (none) for empty tools list", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("Available tools:\n(none)");
		});

		test("shows file paths guideline even with no tools", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("Show file paths clearly");
		});
	});

	describe("default tools", () => {
		test("includes all default tools when snippets are provided", () => {
			const prompt = buildSystemPrompt({
				toolSnippets: {
					read: "Read file contents",
					bash: "Execute bash commands",
					edit: "Make surgical edits",
					write: "Create or overwrite files",
				},
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- read:");
			expect(prompt).toContain("- bash:");
			expect(prompt).toContain("- edit:");
			expect(prompt).toContain("- write:");
		});

		test.each([
			[["powershell"], "Use PowerShell for file operations"],
			[["bash", "powershell"], "Use bash or PowerShell for file operations"],
		] as const)("uses shell-specific guidance for %j", (selectedTools, expected) => {
			const prompt = buildSystemPrompt({
				selectedTools: [...selectedTools],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain(expected);
		});

		test("instructs models to resolve pi docs and examples under absolute base paths", () => {
			const prompt = buildSystemPrompt({
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain(
				"- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory",
			);
			expect(prompt).toContain("environment variables (docs/environment-variables.md)");
		});
	});

	describe("custom tool snippets", () => {
		test("includes custom tools in available tools section when promptSnippet is provided", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				toolSnippets: {
					dynamic_tool: "Run dynamic test behavior",
				},
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- dynamic_tool: Run dynamic test behavior");
		});

		test("omits custom tools from available tools section when promptSnippet is not provided", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).not.toContain("dynamic_tool");
		});
	});

	describe("prompt guidelines", () => {
		test("appends promptGuidelines to default guidelines", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				promptGuidelines: ["Use dynamic_tool for project summaries."],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- Use dynamic_tool for project summaries.");
		});

		test("deduplicates and trims promptGuidelines", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				promptGuidelines: ["Use dynamic_tool for summaries.", "  Use dynamic_tool for summaries.  ", "   "],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt.match(/- Use dynamic_tool for summaries\./g)).toHaveLength(1);
		});
	});

	describe("skills", () => {
		test.each([
			{ name: "default prompt", customPrompt: undefined },
			{ name: "custom prompt", customPrompt: "Custom system prompt" },
		])("includes skills with only bash in the $name", ({ customPrompt }) => {
			const prompt = buildSystemPrompt({
				customPrompt,
				selectedTools: ["bash"],
				contextFiles: [],
				skills: [testSkill],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("<available_skills>");
			expect(prompt).toContain("<name>test-skill</name>");
			expect(prompt).toContain("Use bash to load a skill's file");
		});

		test("omits skills without read or bash", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["write"],
				contextFiles: [],
				skills: [testSkill],
				cwd: process.cwd(),
			});

			expect(prompt).not.toContain("<available_skills>");
		});
	});
});
