# Upstream Integration Pipeline

This fork (`neron82/oh-my-pi`) diverges from upstream
(`can1357/oh-my-pi`) by the **prompt/KV-cache stability work** described in
[docs/prompt-cache-stability.md](prompt-cache-stability.md). Every upstream
release therefore needs a careful integration: merge `main` into
`prompt-cache-stability`, keep the fork's stability layer intact, prove the
result still compiles and passes the fork's tests, replace the installed
binary, and push the integrated branch to GitHub.

Doing that by hand every release is exactly the kind of step that gets
forgotten or done inconsistently. This pipeline turns it into one command:

```sh
bun scripts/integrate-upstream.ts            # full pipeline
bun scripts/integrate-upstream.ts --dry-run  # preview first (no changes)
```

## The one-command flow

The script runs the following stages, in order; each can be skipped:

1. **Preflight** — verifies the repo, the current branch
   (`prompt-cache-stability` by default), and the upstream remote.
2. **Fetch & plan** — fetches upstream `main`, computes the new commits, the
   merge commit message (tag-aware: `Merge tag 'v18.0.4' into
   prompt-cache-stability` when the range contains a new release tag), and —
   critically — the **watch list**: every upstream commit in the range that
   touched a fork-protected path.
3. **Merge** — merges upstream `main` with `--no-ff`. Conflicts on
   **protected paths** are automatically resolved in favor of the fork
   version (`forkWinsOnConflict` in the manifest), because those files carry
   the prompt-cache stability adaptations and cannot adopt upstream's
   conflicting hunks wholesale. Conflicts anywhere else abort the merge and
   roll everything back, telling you exactly which files need a human.
   `git rerere` is enabled, so a conflict you resolve by hand once is
   remembered and auto-resolved on the next integration.
4. **Check** — re-installs dependencies when the merge changed any
   `package.json`/`bun.lock`, runs the full type-check (`bun run check:ts`),
   the fork's stability test suite, and `bun run test:rs` when the merge
   touched `crates/`. This is the safety net that catches upstream API churn
   breaking fork code that the merge kept.
5. **Build** — verifies the host native addon is fresh, then compiles the
   `omp` binary exactly like a local release build
   (`bun packages/coding-agent/scripts/build-binary.ts`, which embeds the
   host's native addons and generated bundles).
6. **Deploy** — clears the loader's `~/.omp/natives/<version>` cache so the
   freshly built binary's *own* embedded addon is exercised, smoke-tests the
   compiled binary (`omp --smoke-test`), refuses to install on failure, then
   atomically replaces `<deploy>/omp` (default `$HOME/.local/bin`, honoring
   `PI_INSTALL_DIR`). `--backup` keeps the previous binary as
   `omp.previous`.
7. **Push** — pushes the integrated branch to the fork remote on GitHub.

```
integrate → check → build → deploy → push
   fetch     type       omp       ~/.local/bin
   merge     tests               (--backup)
   resolve
```

### Native addons (version-sentinel hardening)

Upstream bumps the pi-natives version sentinel (`__piNativesV{major}_{minor}
_{patch}`, derived from `packages/natives/package.json#version`) on every
release. A `.node` built from an older release fails the loader's sentinel
check at binary startup — the exact failure this pipeline hit on the v18.1.3
integration, where the smoke gate caught the stale embed right before deploy.

The pipeline now handles that automatically:

- **Build stage** verifies that the host addon
  (`packages/natives/native/pi_natives.<platform>-<arch>[-modern|-baseline].node`,
  resolved through `scripts/host-detect.ts`) exposes the expected sentinel;
  if it is missing or stale it rebuilds it via `bun run build:native` (the
  repo's local Cargo/N-API host build) and hard-fails if the rebuilt addon
  still lacks the sentinel. If the rebuild regenerates tracked bindings
  (`native/index.js` / `native/index.d.ts`) differently from the merged tree,
  it prints a reminder to commit them.
- **Deploy stage** removes `~/.omp/natives/<version>` before the smoke test,
  so the smoke run extracts and exercises the new binary's own embedded
  addon instead of a cached leftover from an earlier build of the same
  version.

## The protection manifest

`scripts/integrate/fork-paths.json` is the single source of truth for what
the fork owns:

| Key | Meaning |
| --- | --- |
| `upstream` | Remote + ref to integrate from (`origin` / `main`). |
| `integrationBranch` | Branch the fork lives on (`prompt-cache-stability`). |
| `pushRemote` | GitHub remote the result is pushed to (`fork`). |
| `deployDir` | Default binary install dir (`${HOME}/.local/bin`). |
| `forkWinsOnConflict` | Paths that keep the fork version when the merge conflicts. |
| `requiresManualReview` | Paths that abort the merge on conflict (currently the changelog, where dropping either side is wrong). |
| `tests` | The fork's stability test suite run after every merge. |

Keeping this list accurate is a job the script itself can do: after you
commit new fork work, run

```sh
bun scripts/integrate-upstream.ts --sync-manifest
```

It diffs the committed fork state against upstream and adds/removes manifest
entries (paths you have deliberately moved to `requiresManualReview` are
preserved). The manifest also regenerates with `--no-fetch` when you want it
to reflect the last fetched upstream.

### Conflict policy, precisely

- A path in `forkWinsOnConflict` that conflicts → the fork version wins, a
  line appears in the run output, and the merging script's **watch list**
  tells you which upstream commits touched it so you can re-check whether the
  fork adaptation still covers the new upstream behavior.
- A path in `requiresManualReview` that conflicts → pipeline stops. Resolve
  with `git mergetool`, `git commit`, and re-run with
  `--no-fetch --no-merge`. rerere remembers the resolution for next time.
- Any other conflicted path → pipeline stops (same rollback). Pass
  `--auto-other=ours|theirs` to force every remaining conflict — including
  the `requiresManualReview` paths — to resolve on one side without stopping.
  Useful for unattended runs, at the cost of silently dropping one side's
  changes.

## Push destination

The integration result is pushed to **your fork's GitHub repository**, never
to upstream. The script resolves the push remote (manifest `pushRemote`,
default `fork`) and the upstream fetch remote (default `origin`) *by URL* and
refuses to run if they are the same repository — the plan line `push target:
fork` and the checked-in manifest make the destination explicit on every run.

## Common invocations

```sh
# Preview what the next integration would look like (no changes to refs/branches):
bun scripts/integrate-upstream.ts --dry-run

# Full run, unattended, fork wins everywhere:
bun scripts/integrate-upstream.ts --auto-other=ours

# Integrate but do not touch the installed binary yet; just merge + verify:
bun scripts/integrate-upstream.ts --no-build --no-deploy

# Rebuild + redeploy the current branch without merging upstream:
bun scripts/integrate-upstream.ts --no-merge

# Full pipeline into ~/local/bin instead of ~/.local/bin:
bun scripts/integrate-upstream.ts --deploy-dir "$HOME/local/bin"
```

All flags (including `--no-stash`, `--backup`, `--no-smoke`, `--no-fetch`,
`--no-push`, `--upstream <remote>/<ref>`, `--branch`, `--push-remote`,
`--verbose`) are documented at the top of `scripts/integrate-upstream.ts`
and surface in `--help`.

### Dirty worktree

The script auto-stashes uncommitted work around the merge (like
`git merge --autostash`), then pops it back **before** the build — the
pipeline runs on the integrated code plus your work-in-progress, and your WIP
is never committed or pushed. If the pop conflicts, the script stops with
instructions. Pass `--no-stash` to refuse a dirty worktree instead.
`--no-merge` modes (build/deploy of the current state) are fine with a dirty
tree either way.

## CI verification (optional)

`.github/workflows/fork-verify.yml` mirrors the local check stage on every
push to `prompt-cache-stability`: it runs the integration-script contract
tests, the fork stability suite, and the workspace type-check. It is a
verification net for merge commits — merges themselves always happen on your
machine, since the deploy stage needs your local build environment.

## Why it preserves the prompt-cache stability code

Plain `git merge` would put every conflict in front of you and, worse, would
silently *not* tell you when upstream rewrote a file the fork had adapted.
The pipeline inverts that: the files the fork owns are known (manifest),
conflicts there follow the fork's policy automatically, and every upstream
commit that touched them is surfaced in the run output so the re-check that
used to be a manual chore is now a printed checklist. The type-check and the
fork's test suite then prove the kept code still works against the new
upstream APIs — the same reconciliation the fork already does by hand in
commits like *"reconcile KV-aligned compaction with the 17.4 tokenizer budget
API"*.