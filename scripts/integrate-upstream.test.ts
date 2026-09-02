import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const SCRIPT_PATH = path.join(import.meta.dir, "integrate-upstream.ts");

interface RunResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

interface Fixture {
	readonly work: string;
	readonly upstream: string;
	readonly forkSim: string;
	readonly home: string;
	readonly headBefore: string;
}

const MANIFEST = `{
	"upstream": { "remote": "upstream", "ref": "main" },
	"integrationBranch": "prompt-cache-stability",
	"pushRemote": "forksim",
	"deployDir": "${"$"}{HOME}/.local/bin",
	"forkWinsOnConflict": ["lib/stability.ts", "lib/fork-only.ts"],
	"requiresManualReview": ["docs/changelog.md"],
	"tests": []
}
`;

const tempDirs: string[] = [];

async function tmpdir(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function envFor(home: string): Record<string, string> {
	return {
		...process.env,
		HOME: home,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_TERMINAL_PROMPT: "0",
		LC_ALL: "C",
	};
}

async function git(cwd: string, args: readonly string[], env: Record<string, string>): Promise<void> {
	const proc = Bun.spawn(["git", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed (exit ${exitCode}):\n${stdout}\n${stderr}`);
	}
}

/** Initialize a fixture fork colony: work repo + two bare remotes (upstream, fork sim). */
async function makeFixture(
	options: { upstreamCommits?: "none" | "regular" | "tagged"; dirty?: boolean } = {},
): Promise<Fixture> {
	const home = await tmpdir("integrate-home-");
	const work = await tmpdir("integrate-work-");
	await fs.mkdir(path.join(work, "scripts", "integrate"), { recursive: true });
	await fs.mkdir(path.join(work, "lib"), { recursive: true });
	await fs.mkdir(path.join(work, "docs"), { recursive: true });
	await fs.writeFile(path.join(work, "scripts", "integrate", "fork-paths.json"), MANIFEST);
	await fs.writeFile(path.join(work, "lib", "stability.ts"), 'export const stability = "base";\n');
	await fs.writeFile(path.join(work, "lib", "shared.ts"), 'export const shared = "base";\n');
	await fs.writeFile(path.join(work, "lib", "upstream-only.ts"), 'export const upstreamOnly = "base";\n');
	await fs.writeFile(path.join(work, "docs", "changelog.md"), "# Changelog\n\n## [Unreleased]\n\n- base\n");

	const env = envFor(home);
	const baseEnv = {
		...env,
		GIT_AUTHOR_NAME: "test",
		GIT_AUTHOR_EMAIL: "dev@test",
		GIT_COMMITTER_NAME: "test",
		GIT_COMMITTER_EMAIL: "dev@test",
	};
	await git(work, ["init", "-b", "main"], env);
	await git(work, ["config", "user.name", "test"], env);
	await git(work, ["config", "user.email", "dev@test"], env);
	await git(work, ["add", "."], env);
	await git(work, ["commit", "-m", "base"], baseEnv);

	// Fork side: branch off base with a protected-path edit and a new file.
	await git(work, ["branch", "prompt-cache-stability"], env);
	await git(work, ["checkout", "prompt-cache-stability"], env);
	await fs.writeFile(path.join(work, "lib", "stability.ts"), 'export const stability = "fork";\n');
	await fs.writeFile(path.join(work, "lib", "fork-only.ts"), 'export const forkOnly = "fork";\n');
	await git(work, ["add", "."], env);
	await git(work, ["commit", "-m", "fork: stability changes"], baseEnv);

	// Upstream side: a bare remote seeded with base, then upstream commits.
	const upstream = await tmpdir("integrate-upstream-");
	await git(upstream, ["init", "--bare", "-b", "main"], env);
	await git(work, ["remote", "add", "upstream", upstream], env);
	await git(work, ["push", "-u", "upstream", "main"], env);
	if (options.upstreamCommits !== "none") {
		await git(work, ["checkout", "main"], env);
		await fs.writeFile(path.join(work, "lib", "stability.ts"), 'export const stability = "upstream";\n');
		await fs.writeFile(path.join(work, "lib", "upstream-only.ts"), 'export const upstreamOnly = "upstream";\n');
		await fs.writeFile(path.join(work, "lib", "upstream-new.ts"), "export const upstreamNew = true;\n");
		await git(work, ["add", "."], env);
		await git(work, ["commit", "-m", "upstream: main change"], baseEnv);
		await git(work, ["push", "upstream", "main"], env);
		if (options.upstreamCommits === "tagged") {
			await git(work, ["push", "upstream", "--tags"], env);
			const sha = (
				await new Response(
					(
						await Bun.spawn(["git", "rev-parse", "upstream/main"], { cwd: work, env })
					).stdout,
				).text()
			).trim();
			await git(upstream, ["tag", "v99.0.0", sha], env);
		}
		await git(work, ["checkout", "prompt-cache-stability"], env);
	}

	// Fork remote simulated by a second bare repo.
	const forkSim = await tmpdir("integrate-forksim-");
	await git(forkSim, ["init", "--bare", "-b", "prompt-cache-stability"], env);
	await git(work, ["remote", "add", "forksim", forkSim], env);

	if (options.dirty) {
		await fs.writeFile(
			path.join(work, "lib", "shared.ts"),
			'export const shared = "base";\nexport const wip = true;\n',
		);
	}

	const headBefore = (
		await new Response((await Bun.spawn(["git", "rev-parse", "HEAD"], { cwd: work, env })).stdout).text()
	).trim();
	return { work, upstream, forkSim, home, headBefore };
}

async function runScript(fixture: Fixture, extra: readonly string[] = []): Promise<RunResult> {
	const proc = Bun.spawn(
		["bun", SCRIPT_PATH, "--repo", fixture.work, "--no-build", "--no-deploy", "--no-check", ...extra],
		{
			env: envFor(fixture.home),
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const exitCode = await proc.exited;
	return { exitCode, stdout, stderr };
}

async function fileText(fixture: Fixture, relative: string): Promise<string> {
	return Bun.file(path.join(fixture.work, relative)).text();
}

interface CommitFiles {
	readonly [relative: string]: string;
}

/** Commit extra work on the fork branch (the currently checked-out one). */
async function addForkCommit(fixture: Fixture, files: CommitFiles, message: string): Promise<void> {
	const env = envFor(fixture.home);
	const baseEnv = {
		...env,
		GIT_AUTHOR_NAME: "test",
		GIT_AUTHOR_EMAIL: "dev@test",
		GIT_COMMITTER_NAME: "test",
		GIT_COMMITTER_EMAIL: "dev@test",
	};
	for (const [relative, content] of Object.entries(files)) {
		await fs.writeFile(path.join(fixture.work, relative), content);
	}
	await git(fixture.work, ["add", ...Object.keys(files)], env);
	await git(fixture.work, ["commit", "-m", message], baseEnv);
}

/** Commit and push extra work on the upstream main side, returning to the fork branch. */
async function addUpstreamCommit(fixture: Fixture, files: CommitFiles, message: string): Promise<void> {
	const env = envFor(fixture.home);
	const baseEnv = {
		...env,
		GIT_AUTHOR_NAME: "test",
		GIT_AUTHOR_EMAIL: "dev@test",
		GIT_COMMITTER_NAME: "test",
		GIT_COMMITTER_EMAIL: "dev@test",
	};
	await git(fixture.work, ["checkout", "main"], env);
	for (const [relative, content] of Object.entries(files)) {
		await fs.writeFile(path.join(fixture.work, relative), content);
	}
	await git(fixture.work, ["add", ...Object.keys(files)], env);
	await git(fixture.work, ["commit", "-m", message], baseEnv);
	await git(fixture.work, ["push", "upstream", "main"], env);
	await git(fixture.work, ["checkout", "prompt-cache-stability"], env);
}

async function headSubject(fixture: Fixture): Promise<string> {
	const env = envFor(fixture.home);
	const proc = Bun.spawn(["git", "log", "-1", "--format=%s"], {
		cwd: fixture.work,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	return (await new Response(proc.stdout).text()).trim();
}

async function bareSubject(bareRepo: string, ref: string, env: Record<string, string>): Promise<string> {
	const proc = Bun.spawn(["git", "--git-dir", bareRepo, "log", "-1", "--format=%s", ref], {
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	return (await new Response(proc.stdout).text()).trim();
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("integrate-upstream", () => {
	test("merges upstream while keeping protected fork code, pushing the merge to the fork remote", async () => {
		const fixture = await makeFixture({ upstreamCommits: "regular" });
		const result = await runScript(fixture);

		expect(result.exitCode).toBe(0);
		expect(await headSubject(fixture)).toMatch(/^Merge upstream main \([0-9a-f]{8}\)/);
		expect(await fileText(fixture, "lib/stability.ts")).toBe('export const stability = "fork";\n');
		expect(await fileText(fixture, "lib/fork-only.ts")).toBe('export const forkOnly = "fork";\n');
		expect(await fileText(fixture, "lib/upstream-only.ts")).toBe('export const upstreamOnly = "upstream";\n');
		expect(await fileText(fixture, "lib/upstream-new.ts")).toBe("export const upstreamNew = true;\n");
		expect(result.stdout).toContain("kept fork version on conflict: lib/stability.ts");
		expect(result.stdout).toContain("lib/stability.ts");
		expect(result.stdout).toContain("push target:       forksim");
		expect(await bareSubject(fixture.forkSim, "refs/heads/prompt-cache-stability", envFor(fixture.home))).toMatch(
			/^Merge upstream main/,
		);
	});

	test("refuses to run when the push remote is the upstream remote", async () => {
		const fixture = await makeFixture({ upstreamCommits: "regular" });
		// Point the push remote at the same repository as upstream: pushing
		// would land the integration in upstream's repo, not the user's fork.
		await git(fixture.work, ["remote", "set-url", "forksim", fixture.upstream], envFor(fixture.home));

		const result = await runScript(fixture);

		expect(result.exitCode).toBe(1);
		expect(result.stdout + result.stderr).toContain("Refusing to run");
		expect(result.stdout + result.stderr).toContain("upstream remote");
		const env = envFor(fixture.home);
		const headAfter = (
			await new Response((await Bun.spawn(["git", "rev-parse", "HEAD"], { cwd: fixture.work, env })).stdout).text()
		).trim();
		expect(headAfter).toBe(fixture.headBefore);
	});

	test("aborts and rolls back when a non-protected path conflicts", async () => {
		const fixture = await makeFixture({ upstreamCommits: "regular" });
		// Both sides edit shared.ts (not in the manifest): a real conflict outside
		// the protected set must abort the pipeline, not resolve silently.
		await addForkCommit(fixture, { "lib/shared.ts": 'export const shared = "fork";\n' }, "fork: shared change");
		await addUpstreamCommit(
			fixture,
			{ "lib/shared.ts": 'export const shared = "upstream";\n' },
			"upstream: shared change",
		);

		const env = envFor(fixture.home);
		const headBefore = (
			await new Response((await Bun.spawn(["git", "rev-parse", "HEAD"], { cwd: fixture.work, env })).stdout).text()
		).trim();
		const result = await runScript(fixture);

		expect(result.exitCode).toBe(1);
		expect(result.stdout + result.stderr).toContain("lib/shared.ts");
		expect(result.stdout + result.stderr).toContain("Manual resolution required");
		const headAfter = (
			await new Response((await Bun.spawn(["git", "rev-parse", "HEAD"], { cwd: fixture.work, env })).stdout).text()
		).trim();
		expect(headAfter).toBe(headBefore);
		const status = await new Response(
			(await Bun.spawn(["git", "status", "--porcelain"], { cwd: fixture.work, env, stdout: "pipe" })).stdout,
		).text();
		expect(status.trim()).toBe("");
	});

	test("requiresManualReview paths abort the merge even when every other conflict resolves", async () => {
		const fixture = await makeFixture({ upstreamCommits: "regular" });
		// Both sides rewrite the review-only changelog: the pipeline must stop
		// even though the protected stability.ts conflict resolves automatically.
		await addForkCommit(
			fixture,
			{ "docs/changelog.md": "# Changelog\n\n## [Unreleased]\n\n- fork\n" },
			"fork: changelog",
		);
		await addUpstreamCommit(
			fixture,
			{ "docs/changelog.md": "# Changelog\n\n## [Unreleased]\n\n- upstream\n" },
			"upstream: changelog",
		);

		const env = envFor(fixture.home);
		const forkChangelogHead = (
			await new Response((await Bun.spawn(["git", "rev-parse", "HEAD"], { cwd: fixture.work, env })).stdout).text()
		).trim();
		const result = await runScript(fixture);

		expect(result.exitCode).toBe(1);
		expect(result.stdout + result.stderr).toContain("docs/changelog.md");
		const headAfter = (
			await new Response((await Bun.spawn(["git", "rev-parse", "HEAD"], { cwd: fixture.work, env })).stdout).text()
		).trim();
		// The fork's own changelog commit is still HEAD: the merge (and the
		// abort) must not have moved or polluted the branch.
		expect(headAfter).toBe(forkChangelogHead);
	});

	test("--auto-other=ours overrides requiresManualReview and resolves it on the fork side", async () => {
		const fixture = await makeFixture({ upstreamCommits: "regular" });
		await addForkCommit(
			fixture,
			{ "docs/changelog.md": "# Changelog\n\n## [Unreleased]\n\n- fork\n" },
			"fork: changelog",
		);
		await addUpstreamCommit(
			fixture,
			{ "docs/changelog.md": "# Changelog\n\n## [Unreleased]\n\n- upstream\n" },
			"upstream: changelog",
		);

		const result = await runScript(fixture, ["--auto-other=ours"]);

		expect(result.exitCode).toBe(0);
		expect(await headSubject(fixture)).toMatch(/^Merge upstream main/);
		expect(await fileText(fixture, "docs/changelog.md")).toBe("# Changelog\n\n## [Unreleased]\n\n- fork\n");
	});

	test("--auto-other=ours resolves non-protected conflicts on the fork side", async () => {
		const fixture = await makeFixture({ upstreamCommits: "regular" });
		await addForkCommit(fixture, { "lib/shared.ts": 'export const shared = "fork";\n' }, "fork: shared change");
		await addUpstreamCommit(
			fixture,
			{ "lib/shared.ts": 'export const shared = "upstream";\n' },
			"upstream: shared change",
		);

		const result = await runScript(fixture, ["--auto-other=ours"]);

		expect(result.exitCode).toBe(0);
		expect(await headSubject(fixture)).toMatch(/^Merge upstream main/);
		expect(await fileText(fixture, "lib/shared.ts")).toBe('export const shared = "fork";\n');
	});

	test("a tagged upstream release names the tag in the merge commit message", async () => {
		const fixture = await makeFixture({ upstreamCommits: "tagged" });
		const result = await runScript(fixture);

		expect(result.exitCode).toBe(0);
		expect(await headSubject(fixture)).toBe("Merge tag 'v99.0.0' into prompt-cache-stability");
	});

	test("exits 0 without merging when upstream has nothing new", async () => {
		const fixture = await makeFixture({ upstreamCommits: "none" });
		const result = await runScript(fixture);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Up to date");
		const env = envFor(fixture.home);
		const headAfter = (
			await new Response((await Bun.spawn(["git", "rev-parse", "HEAD"], { cwd: fixture.work, env })).stdout).text()
		).trim();
		expect(headAfter).toBe(fixture.headBefore);
	});

	test("auto-stashes a dirty worktree around the merge and restores the WIP", async () => {
		const fixture = await makeFixture({ upstreamCommits: "regular", dirty: true });

		// Default behavior: WIP is stashed for the merge and popped back.
		const integrated = await runScript(fixture);
		expect(integrated.exitCode).toBe(0);
		expect(await headSubject(fixture)).toMatch(/^Merge upstream main/);
		expect(await fileText(fixture, "lib/shared.ts")).toContain("export const wip = true;");
	});

	test("--no-stash refuses a dirty worktree", async () => {
		const fixture = await makeFixture({ upstreamCommits: "regular", dirty: true });

		const refused = await runScript(fixture, ["--no-stash"]);
		expect(refused.exitCode).toBe(1);
		expect(refused.stdout + refused.stderr).toContain("dirty");
		const env = envFor(fixture.home);
		const headAfter = (
			await new Response((await Bun.spawn(["git", "rev-parse", "HEAD"], { cwd: fixture.work, env })).stdout).text()
		).trim();
		expect(headAfter).toBe(fixture.headBefore);
	});

	test("--dry-run leaves head, worktree, and the fork remote untouched", async () => {
		const fixture = await makeFixture({ upstreamCommits: "regular" });
		const result = await runScript(fixture, ["--dry-run"]);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("dry run");
		expect(await headSubject(fixture)).toBe("fork: stability changes");

		const env = envFor(fixture.home);
		const headAfter = (
			await new Response((await Bun.spawn(["git", "rev-parse", "HEAD"], { cwd: fixture.work, env })).stdout).text()
		).trim();
		expect(headAfter).toBe(fixture.headBefore);
		const status = await new Response(
			(await Bun.spawn(["git", "status", "--porcelain"], { cwd: fixture.work, env, stdout: "pipe" })).stdout,
		).text();
		expect(status.trim()).toBe("");
		const forkHead = await bareSubject(fixture.forkSim, "refs/heads/prompt-cache-stability", env);
		expect(forkHead).toBe("");
	});
});
