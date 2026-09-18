#!/usr/bin/env bash
# One-command upstream integration for this fork: fetch, merge, verify, build,
# deploy, push. All pipeline flags pass through, e.g.
#   ./update.sh --dry-run
#   ./update.sh --no-fetch --no-merge    # finish a hand-resolved merge
exec bun "$(dirname "$0")/scripts/integrate-upstream.ts" "$@"
