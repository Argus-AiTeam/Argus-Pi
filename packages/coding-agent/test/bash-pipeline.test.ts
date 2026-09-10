import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBashTool, createLocalBashOperations, createLocalShellOperations } from "../src/core/tools/bash.ts";
import * as shellModule from "../src/utils/shell.ts";

describe("Argus bash pipeline status", () => {
	let cwd: string;
	beforeEach(async () => {
		cwd = await mkdtemp(join(tmpdir(), "argus-pipeline-"));
		vi.stubEnv("PI_HARNESS_PROFILE", undefined);
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		await rm(cwd, { recursive: true, force: true });
	});

	it("reports a failed benchmark even when tee successfully saves its log", async () => {
		const tool = createBashTool(cwd);
		await expect(
			tool.execute("pipeline", { command: "(printf 'verification failed\\n'; exit 7) | tee run.log" }),
		).rejects.toThrow("Command exited with code 7");
		expect(await readFile(join(cwd, "run.log"), "utf8")).toBe("verification failed\n");
	});

	it("keeps successful pipelines successful and preserves stdout", async () => {
		const result = await createBashTool(cwd).execute("pipeline", {
			command: "printf 'verified\\n' | tee run.log",
		});
		expect(result.content[0]).toMatchObject({ type: "text", text: "verified\n" });
		expect(await readFile(join(cwd, "run.log"), "utf8")).toBe("verified\n");
	});

	it("preserves explicit recovery without enabling errexit", async () => {
		const result = await createBashTool(cwd).execute("pipeline", {
			command: "false | cat || printf 'handled\\n'; printf 'continued\\n'",
		});
		expect(result.content[0]).toMatchObject({ type: "text", text: "handled\ncontinued\n" });
	});

	it("lets a command intentionally opt out of pipefail", async () => {
		const result = await createBashTool(cwd).execute("pipeline", {
			command: "set +o pipefail; (printf 'expected\\n'; exit 7) | cat",
		});
		expect(result.content[0]).toMatchObject({ type: "text", text: "expected\n" });
	});

	it("keeps stock-profile pipeline semantics unchanged", async () => {
		vi.stubEnv("PI_HARNESS_PROFILE", "stock");
		const result = await createLocalBashOperations().exec("(exit 7) | cat", cwd, { onData: () => {} });
		expect(result.exitCode).toBe(0);
	});

	it("also propagates pipeline failures when commands travel over stdin", async () => {
		const shell = shellModule.getShellConfig();
		vi.spyOn(shellModule, "getShellConfig").mockReturnValue({
			...shell,
			args: ["-s"],
			commandTransport: "stdin",
		});
		const result = await createLocalBashOperations().exec("(exit 7) | cat", cwd, { onData: () => {} });
		expect(result.exitCode).toBe(7);
	});

	it("does not prepend Bash syntax to other local shell languages", async () => {
		const chunks: Buffer[] = [];
		const result = await createLocalShellOperations("powershell", () => ({
			shell: process.execPath,
			args: ["-e"],
		})).exec("process.stdout.write('native')", cwd, { onData: (data) => chunks.push(data) });
		expect(result.exitCode).toBe(0);
		expect(Buffer.concat(chunks).toString()).toBe("native");
	});

	it("does not rewrite commands delegated to custom remote operations", async () => {
		const exec = vi.fn(async () => ({ exitCode: 0 }));
		const command = "benchmark | tee run.log";
		await createBashTool(cwd, { operations: { exec } }).execute("pipeline", { command });
		expect(exec).toHaveBeenCalledWith(command, cwd, expect.any(Object));
	});

	it("rejects an invalid harness profile before executing the command", async () => {
		vi.stubEnv("PI_HARNESS_PROFILE", "argu");
		await expect(createBashTool(cwd).execute("pipeline", { command: "echo unreachable" })).rejects.toThrow(
			"Unknown PI_HARNESS_PROFILE: argu",
		);
	});
});
