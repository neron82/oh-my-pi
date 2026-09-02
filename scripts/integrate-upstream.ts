#!/usr/bin/env bun
/**
 * One-shot upstream integration for the prompt-cache-stability fork.
 *
 * Fetches upstream main, merges it into the integration branch while
 * preserving the fork's prompt/KV-cache stability changes (policy in
 * scripts/integrate/fork-paths.json), runs the fork's checks, rebuilds the
 * `omp` binary, installs it into the deploy dir (default ~/.local/bin), and
 * pushes the result to the fork remote.
 *
 * Usage: bun scripts/integrate-upstream.ts [flags]
 *
 *   --repo <path>          Repo to operate on (default: this checkout).
 *   --upstream <r>/<ref>   Upstream remote and ref (default: origin/main).
 *   --upstream-ref <ref>   Override only the upstream ref name.
 *   --branch <name>        Branch to integrate into (default: manifest
 *                          integrationBranch).
 *   --push-remote <name>   Remote to push the integrated branch to (default:
 *                          manifest pushRemote).
 *   --deploy-dir <path>    Deploy directory (default: $PI_INSTALL_DIR, else
 *                          manifest deployDir, else ~/.local/bin).
 *   --auto-other <mode>    How to treat conflicts OUTSIDE the manifest:
 *                          "abort" (default) rolls the merge back and
 *                          reports; "ours"/"theirs" resolves them on that
 *                          side, including manifest "requiresManualReview"
 *                          paths (the unattended escape hatch).
 *   --no-stash             Refuse to merge over a dirty worktree instead of
 *                          auto-stashing WIP around the merge (the default,
 *                          popped back before the build).
 *   --backup               Copy the previous binary to <deploy>/omp.previous
 *                          before replacing it.
 *   --no-merge             Skip the upstream merge; integrate the current
 *                          branch HEAD as-is.
 *   --no-check             Skip type-check + fork test suite.
 *   --no-build             Skip compiling the binary.
 *   --no-deploy            Build but do not install into the deploy dir.
 *   --no-smoke             Skips the compiled binary's --smoke-test gate
 *                          before deploy.
 *   --no-push              Do not push to the fork remote.
 *   --no-fetch             Do not fetch upstream (uses existing refs).
 *   --dry-run              Fetch and print the integration plan without
 *                          changing branches, refs, or the worktree.
 *   --sync-manifest        Regenerate fork-paths.json from the committed fork
 *                          diff against upstream, then exit.
 *   --verbose              Print every git command as it runs.
 *
 * Exit codes: 0 success/up-to-date, 1 failure (merge aborted, check failed,
 * build failed, deploy refused, push failed).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

const SCRIPT_DIR = import.meta.dir;
const MANIFEST_REL = path.join("scripts", "integrate", "fork-paths.json");
const BUILD_SCRIPT_REL = path.join("packages", "coding-agent", "scripts", "build-binary.ts");
const BUILD_OUTPUT_REL = path.join("packages", "coding-agent", "dist", "omp");

const USAGE = `Usage: bun scripts/integrate-upstream.ts [flags]

One-shot upstream integration for the prompt-cache-stability fork:
fetch upstream -> merge (fork policy from scripts/integrate/fork-paths.json)
-> check -> build -> deploy -> push.

Flags:
  --repo <path>          Repo to operate on (default: this checkout).
  --upstream <r>/<ref>   Upstream remote and ref (default: origin/main).
  --upstream-ref <ref>   Override only the upstream ref name.
  --branch <name>        Branch to integrate into (default: manifest).
  --push-remote <name>   Remote to push the result to (default: manifest).
  --deploy-dir <path>    Install dir for the binary (default: ~/.local/bin).
  --auto-other <mode>    Conflicts outside the manifest: abort (default),
                         or resolve them on ours|theirs (including the
                         requiresManualReview paths).
  --no-stash             Refuse a dirty worktree instead of auto-stashing
                         WIP around the merge (auto-stash is the default).
  --backup               Keep the previous binary as <deploy>/omp.previous.
  --no-merge             Integrate the current branch HEAD as-is.
  --no-check             Skip type-check + fork test suite.
  --no-build             Skip compiling the binary.
  --no-deploy            Build but do not install.
  --no-smoke             Skip the binary's --smoke-test gate before deploy.
  --no-push              Do not push to the fork remote.
  --no-fetch             Do not fetch upstream (uses existing refs).
  --dry-run              Print the integration plan; change nothing.
  --sync-manifest        Regenerate fork-paths.json from the committed fork
                         diff against upstream, then exit.
  --verbose              Print every git command as it runs.

Exit codes: 0 success/up-to-date, 1 failure (merge aborted, a check or the
build failed, deploy refused, push failed).`;

interface ForkPathsManifest {
	readonly _comment?: string;
	readonly upstream: { readonly remote: string; readonly ref: string };
	readonly integrationBranch: string;
	readonly pushRemote: string;
	readonly deployDir: string;
	readonly forkWinsOnConflict: readonly string[];
	readonly requiresManualReview: readonly string[];
	readonly tests: readonly string[];
}

interface Flags {
	repo?: string;
	upstream?: string;
	upstreamRef?: string;
	branch?: string;
	pushRemote?: string;
	deployDir?: string;
	autoOther: "abort" | "ours" | "theirs";
	noStash: boolean;
	backup: boolean;
	noMerge: boolean;
	noCheck: boolean;
	noBuild: boolean;
	noDeploy: boolean;
	noSmoke: boolean;
	noPush: boolean;
	noFetch: boolean;
	dryRun: boolean;
	syncManifest: boolean;
	verbose: boolean;
}

interface GitResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

interface UpstreamPlan {
	readonly base: string;
	readonly head: string;
	readonly newCount: number;
	readonly newCommits: readonly string[];
	readonly newTag: string | null;
	readonly message: string;
}

function parseFlags(argv: readonly string[]): Flags {
	const flags: Flags = {
		autoOther: "abort",
		noStash: false,
		backup: false,
		noMerge: false,
		noCheck: false,
		noBuild: false,
		noDeploy: false,
		noSmoke: false,
		noPush: false,
		noFetch: false,
		dryRun: false,
		syncManifest: false,
		verbose: false,
	};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const flag = arg.startsWith("--") && arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
		const inline = arg.startsWith("--") && arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : undefined;
		const takeValue = (): string => {
			if (inline !== undefined) return inline;
			const next = argv[i + 1];
			if (next === undefined || next.startsWith("--")) {
				throw new Error(`Flag ${flag} requires a value.`);
			}
			i += 1;
			return next;
		};
		switch (flag) {
			case "--help":
				console.log(USAGE);
				process.exit(0);
				break;
			case "--repo":
				flags.repo = takeValue();
				break;
			case "--upstream":
				flags.upstream = takeValue();
				break;
			case "--upstream-ref":
				flags.upstreamRef = takeValue();
				break;
			case "--branch":
				flags.branch = takeValue();
				break;
			case "--push-remote":
				flags.pushRemote = takeValue();
				break;
			case "--deploy-dir":
				flags.deployDir = takeValue();
				break;
			case "--auto-other":
				flags.autoOther = takeValue() as Flags["autoOther"];
				if (flags.autoOther !== "abort" && flags.autoOther !== "ours" && flags.autoOther !== "theirs") {
					throw new Error(`--auto-other must be one of abort|ours|theirs, got ${flags.autoOther}`);
				}
				break;
			case "--no-stash":
				flags.noStash = true;
				break;
			case "--backup":
				flags.backup = true;
				break;
			case "--no-merge":
				flags.noMerge = true;
				break;
			case "--no-check":
				flags.noCheck = true;
				break;
			case "--no-build":
				flags.noBuild = true;
				break;
			case "--no-deploy":
				flags.noDeploy = true;
				break;
			case "--no-smoke":
				flags.noSmoke = true;
				break;
			case "--no-push":
				flags.noPush = true;
				break;
			case "--no-fetch":
				flags.noFetch = true;
				break;
			case "--dry-run":
				flags.dryRun = true;
				break;
			case "--sync-manifest":
				flags.syncManifest = true;
				break;
			case "--verbose":
				flags.verbose = true;
				break;
			default:
				throw new Error(`Unknown flag: ${arg}\n${USAGE}`);
		}
	}
	return flags;
}

async function readJson(pathName: string): Promise<unknown> {
	try {
		return await Bun.file(pathName).json();
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw err;
	}
}

function expandEnv(template: string, env: Record<string, string | undefined>): string {
	return template.replace(/\$\{?([A-Z_][A-Z0-9_]*)\}?/g, (match, name: string) => env[name] ?? match);
}

function resolveManifestPath(repoRoot: string): string {
	return path.join(repoRoot, MANIFEST_REL);
}

async function loadManifest(repoRoot: string): Promise<ForkPathsManifest> {
	const raw = await readJson(resolveManifestPath(repoRoot));
	const candidate = raw as Partial<ForkPathsManifest> | null;
	if (
		candidate === null ||
		typeof candidate !== "object" ||
		typeof candidate.upstream?.remote !== "string" ||
		typeof candidate.upstream?.ref !== "string" ||
		typeof candidate.integrationBranch !== "string" ||
		typeof candidate.pushRemote !== "string" ||
		typeof candidate.deployDir !== "string" ||
		!Array.isArray(candidate.forkWinsOnConflict) ||
		!Array.isArray(candidate.requiresManualReview) ||
		!Array.isArray(candidate.tests)
	) {
		throw new Error(`Invalid or missing integration manifest at ${resolveManifestPath(repoRoot)}.`);
	}
	return candidate as ForkPathsManifest;
}

async function resolveUpstreamRef(flags: Flags, manifest: ForkPathsManifest): Promise<{ remote: string; ref: string }> {
	if (flags.upstream !== undefined) {
		const slash = flags.upstream.indexOf("/");
		if (slash <= 0 || slash === flags.upstream.length - 1) {
			throw new Error(`--upstream must be <remote>/<ref>, got ${flags.upstream}`);
		}
		return { remote: flags.upstream.slice(0, slash), ref: flags.upstream.slice(slash + 1) };
	}
	return { remote: manifest.upstream.remote, ref: flags.upstreamRef ?? manifest.upstream.ref };
}

function gitEnv(): Record<string, string> {
	return { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };
}

async function runGit(cwd: string, args: readonly string[], options: { verbose?: boolean } = {}): Promise<GitResult> {
	if (options.verbose) {
		console.log(`git ${args.join(" ")}`);
	}
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		env: gitEnv(),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const exitCode = await proc.exited;
	return { exitCode, stdout, stderr };
}

async function gitChecked(cwd: string, args: readonly string[], options: { verbose?: boolean } = {}): Promise<string> {
	const result = await runGit(cwd, args, options);
	if (result.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed (exit ${result.exitCode})\n${result.stderr.trim()}`);
	}
	return result.stdout;
}

async function inspectRepo(repoRoot: string, verbose: boolean): Promise<void> {
	await gitChecked(repoRoot, ["rev-parse", "--git-dir"], { verbose });
	const currentBranch = await gitChecked(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"], { verbose });
	if (currentBranch === "HEAD") {
		throw new Error("Detached HEAD: check out a branch before integrating.");
	}
}

async function fetchUpstream(repoRoot: string, remote: string, verbose: boolean): Promise<void> {
	const result = await runGit(repoRoot, ["fetch", "--prune", remote], { verbose });
	if (result.exitCode !== 0) {
		throw new Error(
			`Could not fetch upstream remote "${remote}". Check that it exists (git remote -v) and is reachable.\n${result.stderr.trim()}`,
		);
	}
}

async function verifyUpstreamRef(repoRoot: string, remote: string, ref: string, verbose: boolean): Promise<void> {
	const result = await runGit(repoRoot, ["rev-parse", "--verify", `refs/remotes/${remote}/${ref}`], { verbose });
	if (result.exitCode !== 0) {
		throw new Error(
			`Upstream ref ${remote}/${ref} does not exist. Fetch remote first or pass --upstream <remote>/<ref>.`,
		);
	}
}

async function latestTagFor(repoRoot: string, ref: string, verbose: boolean): Promise<string | null> {
	const result = await runGit(repoRoot, ["describe", "--tags", "--abbrev=0", ref], { verbose });
	if (result.exitCode !== 0) return null;
	return result.stdout.trim() || null;
}

async function isAncestor(repoRoot: string, ancestor: string, descendant: string, verbose: boolean): Promise<boolean> {
	const result = await runGit(repoRoot, ["merge-base", "--is-ancestor", ancestor, descendant], { verbose });
	return result.exitCode === 0;
}

async function computePlan(
	repoRoot: string,
	branch: string,
	upstreamRef: string,
	verbose: boolean,
): Promise<UpstreamPlan> {
	const base = (await gitChecked(repoRoot, ["merge-base", branch, upstreamRef], { verbose })).trim();
	const head = (await gitChecked(repoRoot, ["rev-parse", "-q", upstreamRef], { verbose })).trim();
	const newCommits = (
		await gitChecked(repoRoot, ["rev-list", "--oneline", "--no-merges", `${base}..${upstreamRef}`], { verbose })
	)
		.split("\n")
		.filter(line => line.trim().length > 0);

	let newTag: string | null = null;
	const tagged = await latestTagFor(repoRoot, upstreamRef, verbose);
	if (tagged !== null && !(await isAncestor(repoRoot, tagged, "HEAD", verbose))) {
		newTag = tagged;
	}

	const shortHead = head.slice(0, 8);
	const refName = upstreamRef.split("/").pop() ?? "main";
	const message =
		newTag !== null
			? `Merge tag '${newTag}' into ${branch}`
			: `Merge upstream ${refName} (${shortHead}) into ${branch}`;

	return { base, head, newCount: newCommits.length, newCommits, newTag, message };
}

/** Upstream commits in the merged range that touched the given paths. */
async function watchList(
	repoRoot: string,
	base: string,
	upstreamRef: string,
	paths: readonly string[],
	verbose: boolean,
): Promise<Map<string, readonly string[]>> {
	const result: Map<string, readonly string[]> = new Map();
	for (const pathName of paths) {
		const commits = (
			await gitChecked(repoRoot, ["log", "--format=%h %s", `${base}..${upstreamRef}`, "--", pathName], { verbose })
		)
			.split("\n")
			.filter(line => line.trim().length > 0);
		if (commits.length > 0) {
			result.set(pathName, commits);
		}
	}
	return result;
}

async function unmergedPaths(repoRoot: string, verbose: boolean): Promise<string[]> {
	const result = await runGit(repoRoot, ["diff", "--name-only", "--diff-filter=U"], { verbose });
	if (result.exitCode !== 0) return [];
	return result.stdout.split("\n").filter(line => line.trim().length > 0);
}

interface MergeOutcome {
	readonly mergeSha: string | null;
	readonly forkResolved: readonly string[];
	readonly otherResolved: readonly string[];
	readonly aborted: boolean;
	readonly abortedPaths: readonly string[];
}

async function runMerge(
	repoRoot: string,
	upstreamRef: string,
	message: string,
	manifest: ForkPathsManifest,
	autoOther: Flags["autoOther"],
	verbose: boolean,
): Promise<MergeOutcome> {
	const merge = await runGit(repoRoot, ["merge", "--no-edit", "--no-ff", "--no-verify", "-m", message, upstreamRef], {
		verbose,
	});
	if (merge.exitCode === 0) {
		const mergeSha = (await gitChecked(repoRoot, ["rev-parse", "HEAD"], { verbose })).trim();
		return { mergeSha, forkResolved: [], otherResolved: [], aborted: false, abortedPaths: [] };
	}

	const unresolved = await unmergedPaths(repoRoot, verbose);
	if (unresolved.length === 0) {
		throw new Error(`git merge failed for an unexpected reason:\n${merge.stderr.trim()}`);
	}

	const forkSet = new Set(manifest.forkWinsOnConflict);

	const forkResolved: string[] = [];
	const otherResolved: string[] = [];
	const abortedPaths: string[] = [];

	for (const pathName of unresolved) {
		// fork-protected paths always keep the fork version; everything else
		// resolves on the requested side or aborts the merge (default).
		const side = forkSet.has(pathName) ? "ours" : autoOther === "abort" ? null : autoOther;
		if (side === null) {
			abortedPaths.push(pathName);
			continue;
		}
		const checkout = await runGit(repoRoot, ["checkout", side === "ours" ? "--ours" : "--theirs", "--", pathName], {
			verbose,
		});
		if (checkout.exitCode !== 0) {
			abortedPaths.push(pathName);
			continue;
		}
		await gitChecked(repoRoot, ["add", "--", pathName], { verbose });
		if (forkSet.has(pathName)) {
			forkResolved.push(pathName);
		} else {
			otherResolved.push(pathName);
		}
	}

	if (abortedPaths.length > 0) {
		await gitChecked(repoRoot, ["merge", "--abort"], { verbose });
		return { mergeSha: null, forkResolved, otherResolved, aborted: true, abortedPaths };
	}

	const continueMerge = await runGit(repoRoot, ["commit", "--no-verify", "-m", message], { verbose });
	if (continueMerge.exitCode !== 0) {
		throw new Error(`Could not finalize the merge:\n${continueMerge.stderr.trim()}`);
	}
	const mergeSha = (await gitChecked(repoRoot, ["rev-parse", "HEAD"], { verbose })).trim();
	return { mergeSha, forkResolved, otherResolved, aborted: false, abortedPaths: [] };
}

async function pathChangedIn(
	repoRoot: string,
	base: string,
	head: string,
	pattern: readonly string[],
	verbose: boolean,
): Promise<boolean> {
	const result = await runGit(repoRoot, ["diff", "--name-only", base, head, "--", ...pattern], { verbose });
	return result.exitCode === 0 && result.stdout.trim().length > 0;
}

async function runCommandInherit(cwd: string, command: readonly string[], phase: string): Promise<void> {
	console.log(`\n==> ${phase}`);
	const proc = Bun.spawn(command, { cwd, env: { ...process.env }, stdout: "inherit", stderr: "inherit" });
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		throw new Error(`${phase} failed (exit ${exitCode}): ${command.join(" ")}`);
	}
}

async function runChecks(repoRoot: string, base: string, manifest: ForkPathsManifest, verbose: boolean): Promise<void> {
	const changed = (await gitChecked(repoRoot, ["diff", "--name-only", base, "HEAD"], { verbose }))
		.split("\n")
		.filter(line => line.trim().length > 0);

	const depManifests = changed.filter(
		line => line === "bun.lock" || line === "package.json" || line.endsWith("/package.json"),
	);
	if (depManifests.length > 0) {
		console.log(`\n==> Dependency manifests changed (${depManifests.join(", ")}); installing`);
		await runCommandInherit(repoRoot, ["bun", "install"], "bun install");
	} else {
		console.log("\n==> No dependency changes; skipping bun install");
	}

	await runCommandInherit(repoRoot, ["bun", "run", "check:ts"], "Type-check (bun run check:ts)");

	if (manifest.tests.length > 0) {
		await runCommandInherit(repoRoot, ["bun", "test", ...manifest.tests], "Fork stability test suite");
	}

	const rustChanged = await pathChangedIn(
		repoRoot,
		base,
		"HEAD",
		["crates/", "Cargo.toml", "Cargo.lock", ".cargo/", "rust-toolchain.toml"],
		verbose,
	);
	if (rustChanged) {
		await runCommandInherit(repoRoot, ["bun", "run", "test:rs"], "Rust tests (bun run test:rs)");
	}
}

async function runBuild(repoRoot: string): Promise<string> {
	const buildScript = path.join(repoRoot, BUILD_SCRIPT_REL);
	await runCommandInherit(repoRoot, ["bun", buildScript], "Compile omp binary (build-binary.ts)");
	const built = path.join(repoRoot, BUILD_OUTPUT_REL);
	try {
		const stat = await fs.stat(built);
		if (!stat.isFile()) throw new Error("not a file");
	} catch (err) {
		throw new Error(`Build finished but no binary at ${built}: ${(err as Error).message}`);
	}
	return built;
}

async function binaryVersion(binaryPath: string): Promise<string | null> {
	const proc = Bun.spawn([binaryPath, "--version"], { stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		return null;
	}
	const firstLine = stdout.split("\n")[0] ?? stderr.split("\n")[0] ?? "";
	return firstLine.trim() || null;
}

async function runDeploy(
	built: string,
	deployDir: string,
	backup: boolean,
	smoke: boolean,
): Promise<{ oldVersion: string | null; newVersion: string | null }> {
	await fs.mkdir(deployDir, { recursive: true });

	const newVersion = await binaryVersion(built);
	console.log(`\n==> Built binary: ${built} (${newVersion ?? "unknown version"})`);

	if (smoke) {
		const proc = Bun.spawn([built, "--smoke-test"], { stdout: "inherit", stderr: "inherit" });
		const exitCode = await proc.exited;
		if (exitCode !== 0) {
			throw new Error(
				`Refusing to deploy: the freshly built binary failed its own smoke test (exit ${exitCode}). Deploy aborted; existing install at ${path.join(deployDir, "omp")} is untouched.`,
			);
		}
		console.log("==> Compiled binary smoke-test passed");
	}

	const target = path.join(deployDir, "omp");
	const oldVersion = (await fs.stat(target).catch(() => null)) !== null ? await binaryVersion(target) : null;

	if (backup && oldVersion !== null) {
		await fs.copyFile(target, path.join(deployDir, "omp.previous"));
		console.log(`==> Backed up previous binary to ${path.join(deployDir, "omp.previous")}`);
	}

	const tmp = path.join(deployDir, `.omp.staged.${process.pid}`);
	await fs.copyFile(built, tmp);
	await fs.rename(tmp, target);
	await fs.chmod(target, 0o755);

	console.log(`==> Installed ${target}`);
	console.log(`    version: ${oldVersion ?? "?"} -> ${newVersion ?? "?"}`);
	return { oldVersion, newVersion };
}

async function runPush(repoRoot: string, pushRemote: string, branch: string, verbose: boolean): Promise<void> {
	const tracking = `refs/remotes/${pushRemote}/${branch}`;
	const haveTracking = (await runGit(repoRoot, ["rev-parse", "--verify", "-q", tracking], { verbose })).exitCode === 0;
	if (haveTracking) {
		const ahead = Number.parseInt(
			(await gitChecked(repoRoot, ["rev-list", "--count", `${tracking}..HEAD`], { verbose })).trim(),
			10,
		);
		const behind = Number.parseInt(
			(await gitChecked(repoRoot, ["rev-list", "--count", `HEAD..${tracking}`], { verbose })).trim(),
			10,
		);
		if (ahead === 0 && behind === 0) {
			console.log(`\n==> Nothing to push: ${pushRemote}/${branch} already at HEAD`);
			return;
		}
		if (ahead === 0 && behind > 0) {
			console.log(
				`\n==> ${pushRemote}/${branch} has ${behind} commit(s) we do not have (remote advanced elsewhere). ` +
					`Not pushing. Reconcile (git pull --rebase ${pushRemote} ${branch}) before retrying.`,
			);
			return;
		}
	}
	console.log(`\n==> Pushing ${branch} to ${pushRemote}`);
	const push = await runGit(repoRoot, ["push", pushRemote, branch], { verbose });
	if (push.exitCode !== 0) {
		throw new Error(
			`Push to ${pushRemote} failed. The integration is complete locally; push it manually or retry with --no-push.\n${push.stderr.trim()}`,
		);
	}
	console.log(push.stdout.trim());
	const mergeSha = (await gitChecked(repoRoot, ["rev-parse", "HEAD"], { verbose })).trim();
	console.log(`==> Pushed ${branch} (${mergeSha.slice(0, 12)}) to ${pushRemote}`);
}

function printPlan(
	plan: UpstreamPlan,
	manifest: ForkPathsManifest,
	pushRemote: string,
	watch: Map<string, readonly string[]>,
	verbose: boolean,
): void {
	const WATCH_PREVIEW = 3;
	console.log(`\n--- integration plan ---`);
	console.log(`upstream:          ${plan.newCount} new commits (${plan.base.slice(0, 8)}..${plan.head.slice(0, 8)})`);
	console.log(`merge commit:      ${plan.message}`);
	console.log(
		`auto-resolve:      ${manifest.forkWinsOnConflict.length} protected paths keep the fork version on conflict`,
	);
	console.log(`manual review:     ${manifest.requiresManualReview.join(", ") || "none"}`);
	console.log(`push target:       ${pushRemote} (never the upstream remote)`);
	if (watch.size > 0) {
		console.log(`upstream commits touching protected paths (recheck fork adaptation):`);
		for (const [pathName, commits] of watch) {
			const preview = commits.slice(0, WATCH_PREVIEW);
			console.log(`  ${pathName} (${commits.length} commit${commits.length > 1 ? "s" : ""})`);
			for (const commit of preview) {
				console.log(`    ${commit}`);
			}
			if (commits.length > preview.length) {
				console.log(
					`    … and ${commits.length - preview.length} more${verbose ? "" : " (--verbose lists them all)"}`,
				);
			}
		}
	} else {
		console.log("upstream commits touching protected paths: none");
	}
}

async function syncManifest(
	repoRoot: string,
	manifest: ForkPathsManifest,
	upstreamRef: string,
	verbose: boolean,
): Promise<void> {
	const statuses = (
		await gitChecked(repoRoot, ["diff", "--name-status", "--no-renames", upstreamRef, "HEAD"], { verbose })
	)
		.split("\n")
		.filter(line => line.trim().length > 0);
	const forkPaths = statuses
		.map(line => {
			const [status, ...rest] = line.split("\t");
			const pathName = rest.join("\t");
			return { status, pathName };
		})
		.filter(entry => entry.status !== "D" && entry.pathName.length > 0)
		.map(entry => entry.pathName);

	const reviewSet = new Set(manifest.requiresManualReview);
	const existingTests = new Set(manifest.tests);
	const newForkWins = [...new Set([...forkPaths])].filter(pathName => !reviewSet.has(pathName)).sort();
	const newTests = [
		...new Set([...existingTests, ...newForkWins.filter(pathName => pathName.endsWith(".test.ts"))]),
	].sort();

	const updated: ForkPathsManifest = {
		...(manifest._comment !== undefined ? { _comment: manifest._comment } : {}),
		upstream: manifest.upstream,
		integrationBranch: manifest.integrationBranch,
		pushRemote: manifest.pushRemote,
		deployDir: manifest.deployDir,
		forkWinsOnConflict: newForkWins,
		requiresManualReview: manifest.requiresManualReview,
		tests: newTests,
	};

	const before = new Set(manifest.forkWinsOnConflict);
	const after = new Set(newForkWins);
	for (const pathName of after) {
		if (!before.has(pathName)) console.log(`added    ${pathName}`);
	}
	for (const pathName of before) {
		if (!after.has(pathName)) console.log(`removed  ${pathName}`);
	}

	await Bun.write(resolveManifestPath(repoRoot), `${JSON.stringify(updated, null, "\t")}\n`);
	console.log(`\n==> Rewrote ${resolveManifestPath(repoRoot)}`);
}

function planDeployTarget(flags: Flags, manifest: ForkPathsManifest): string {
	if (flags.deployDir !== undefined) return expandEnv(flags.deployDir, process.env);
	if (process.env.PI_INSTALL_DIR) return expandEnv(process.env.PI_INSTALL_DIR, process.env);
	return expandEnv(manifest.deployDir, { ...process.env, HOME: process.env.HOME ?? "" });
}

function printSummary(summary: readonly string[]): void {
	console.log("\n--- summary ---");
	for (const line of summary) {
		console.log(line);
	}
}

async function main(): Promise<void> {
	const flags = parseFlags(process.argv.slice(2));
	const repoRoot = path.resolve(flags.repo ?? path.join(SCRIPT_DIR, ".."));
	const manifest = await loadManifest(repoRoot);

	if (flags.syncManifest) {
		if (!flags.noFetch) {
			await fetchUpstream(repoRoot, manifest.upstream.remote, flags.verbose);
		}
		const resolved = await resolveUpstreamRef(flags, manifest);
		await verifyUpstreamRef(repoRoot, resolved.remote, resolved.ref, flags.verbose);
		await syncManifest(repoRoot, manifest, `refs/remotes/${resolved.remote}/${resolved.ref}`, flags.verbose);
		return;
	}

	await inspectRepo(repoRoot, flags.verbose);
	const branch = flags.branch ?? manifest.integrationBranch;
	const currentBranch = (
		await gitChecked(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"], { verbose: flags.verbose })
	).trim();
	if (!flags.noMerge && currentBranch !== branch) {
		throw new Error(
			`Integration branch mismatch: on "${currentBranch}", expected "${branch}". Check out the integration branch (or pass --branch).`,
		);
	}

	const resolved = await resolveUpstreamRef(flags, manifest);
	const upstreamRef = flags.noMerge ? null : `refs/remotes/${resolved.remote}/${resolved.ref}`;
	if (!flags.noFetch && !flags.noMerge) {
		await fetchUpstream(repoRoot, resolved.remote, flags.verbose);
	}
	if (upstreamRef !== null) {
		await verifyUpstreamRef(repoRoot, resolved.remote, resolved.ref, flags.verbose);
	}

	const pushRemote = flags.pushRemote ?? manifest.pushRemote;
	// The integration result goes to the user's own GitHub remote — never to
	// upstream's. Compare URLs so a differently-named remote still trips the
	// guard (e.g. a fork that happens to be called "origin").
	const upstreamUrl = (
		await runGit(repoRoot, ["remote", "get-url", resolved.remote], { verbose: flags.verbose })
	).stdout.trim();
	const pushUrl = (
		await runGit(repoRoot, ["remote", "get-url", pushRemote], { verbose: flags.verbose })
	).stdout.trim();
	if (upstreamUrl !== "" && upstreamUrl === pushUrl) {
		throw new Error(
			`Refusing to run: push remote "${pushRemote}" (${pushUrl}) is the upstream remote "${resolved.remote}". ` +
				`The integration would be pushed to upstream's repository. Set a distinct push remote (e.g. your fork) ` +
				`via the manifest's pushRemote or --push-remote, or pass --no-push.`,
		);
	}

	const summary: string[] = [];
	let mergeSha: string | null = null;
	let base: string | null = null;

	if (upstreamRef !== null) {
		const plan = await computePlan(repoRoot, branch, upstreamRef, flags.verbose);
		if (plan.newCount === 0) {
			console.log(
				`\nUp to date: ${resolved.remote}/${resolved.ref} has no commits beyond ${branch}. Nothing to integrate.`,
			);
			if (!flags.dryRun) {
				return;
			}
		}
		const watch = await watchList(
			repoRoot,
			plan.base,
			upstreamRef,
			[...manifest.forkWinsOnConflict, ...manifest.requiresManualReview],
			flags.verbose,
		);
		printPlan(plan, manifest, pushRemote, watch, flags.verbose);

		if (flags.dryRun) {
			console.log("\n(dry run: no branches, refs, or files were changed; fetch updated remote refs only)");
			return;
		}
		if (plan.newCount === 0) {
			return;
		}

		base = plan.base;

		// git rerere: recurrences of a conflict resolve from the recorded
		// previous resolution instead of blocking the pipeline again.
		await gitChecked(repoRoot, ["config", "rerere.enabled", "true"], { verbose: flags.verbose });
		await gitChecked(repoRoot, ["config", "rerere.autoUpdate", "true"], { verbose: flags.verbose });

		const dirty =
			(await gitChecked(repoRoot, ["status", "--porcelain"], { verbose: flags.verbose })).trim().length > 0;
		let stashed = false;
		if (dirty) {
			if (flags.noStash) {
				throw new Error(
					"Working tree is dirty and --no-stash was passed. Commit or stash your changes first, or drop --no-stash to auto-stash WIP around the merge.",
				);
			}
			await gitChecked(repoRoot, ["stash", "push", "-m", "integrate-upstream: pre-merge WIP"], {
				verbose: flags.verbose,
			});
			stashed = true;
			console.log("==> Stashed working tree WIP around the merge (auto-stash; popped back after)");
		}

		const outcome = await runMerge(repoRoot, upstreamRef, plan.message, manifest, flags.autoOther, flags.verbose);

		if (outcome.aborted) {
			if (stashed) {
				await gitChecked(repoRoot, ["stash", "pop"], { verbose: flags.verbose });
			}
			throw new Error(
				`Merge aborted; no changes were made. Manual resolution required for:\n${outcome.abortedPaths.map(pathName => `  ${pathName}`).join("\n")}\n` +
					`Resolve them with git mergetool (rerere is enabled and will remember the resolution), then run:\n` +
					`  git commit          # complete the merge\n` +
					`  bun scripts/integrate-upstream.ts --no-fetch --no-merge\n` +
					`Alternatively rerun with --auto-other=ours|theirs to resolve them on one side automatically.`,
			);
		}

		mergeSha = outcome.mergeSha;
		if (stashed) {
			const pop = await runGit(repoRoot, ["stash", "pop"], { verbose: flags.verbose });
			if (pop.exitCode !== 0) {
				throw new Error(
					`Merge succeeded but restoring your stashed WIP conflicted:\n${pop.stderr.trim()}\n` +
						`Resolve the stash conflict in the worktree and finish with: git stash drop`,
				);
			}
			console.log("==> Restored stashed WIP");
		}

		console.log(`\n==> Integrated: ${plan.message}`);
		console.log(`    merge commit: ${mergeSha?.slice(0, 12) ?? "?"}`);
		if (outcome.forkResolved.length > 0) {
			console.log(`    kept fork version on conflict: ${outcome.forkResolved.join(", ")}`);
		}
		if (outcome.otherResolved.length > 0) {
			console.log(`    auto-resolved on one side: ${outcome.otherResolved.join(", ")}`);
		}
		if (watch.size > 0) {
			console.log("    recheck these protected paths against the merged upstream commits:");
			for (const [pathName, commits] of watch) {
				console.log(`      ${pathName} (${commits.length} upstream commit${commits.length > 1 ? "s" : ""})`);
			}
		}
		summary.push(
			`integrated ${plan.base.slice(0, 8)}..${plan.head.slice(0, 8)} (${plan.newCount} commits) as ${mergeSha?.slice(0, 12) ?? "?"}`,
		);
	}

	if (!flags.noCheck) {
		const checkBase =
			base ?? (await gitChecked(repoRoot, ["rev-parse", "-q", "HEAD"], { verbose: flags.verbose })).trim();
		await runChecks(repoRoot, checkBase, manifest, flags.verbose);
		summary.push("checks passed (type-check + fork stability tests)");
	}

	let built: string | null = null;
	if (!flags.noBuild) {
		built = await runBuild(repoRoot);
		summary.push(`built ${path.relative(repoRoot, built)}`);
	}

	if (!flags.noDeploy && built !== null) {
		const deployDir = planDeployTarget(flags, manifest);
		const deployed = await runDeploy(built, deployDir, flags.backup, !flags.noSmoke);
		summary.push(
			`deployed to ${path.join(deployDir, "omp")} (${deployed.oldVersion ?? "?"} -> ${deployed.newVersion ?? "?"})`,
		);
	}

	if (!flags.noPush) {
		await runPush(repoRoot, pushRemote, branch, flags.verbose);
		summary.push(`pushed ${branch} -> ${pushRemote}`);
	} else {
		summary.push(`push skipped (--no-push); run: git push ${pushRemote} ${branch}`);
	}

	printSummary(summary);
}

if (import.meta.main) {
	await main().catch((err: unknown) => {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`\nintegrate-upstream: ${message}`);
		process.exit(1);
	});
}
