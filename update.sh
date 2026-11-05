#!/usr/bin/env bash
# One-command upstream integration for this fork: fetch, merge, verify, build,
# deploy, push. All pipeline flags pass through, e.g.
#   ./update.sh --dry-run
#   ./update.sh --no-fetch --no-merge --backup  # resume after committing integration fixes
#   ./update.sh --no-push                      # local build of uncommitted WIP
#
# Rust tests are skipped by default: upstream's pi-shell testkit is written for
# macOS (libc/libm/terminfo expectations) and carries escape sequences mangled by
# upstream's own rustfmt rewrap, so `bun run test:rs` cannot pass on Linux. The
# native addon build still compiles every crate, and GitHub CI runs no Rust gate.
# Run them anyway with:  OMP_RS_TESTS=1 ./update.sh
set -euo pipefail
flags=()
if [ "${OMP_RS_TESTS:-0}" != "1" ]; then
	flags+=(--no-rs-tests)
fi
exec bun "$(dirname "$0")/scripts/integrate-upstream.ts" "$@" "${flags[@]}"
