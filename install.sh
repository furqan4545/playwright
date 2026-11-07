#!/bin/bash
# Set up Playwright browser automation for every AI agent on this Mac: installs Playwright, its MCP
# server and CLI plus Chromium, then registers the browser tools with each agent app it finds.
# Safe to run again: anything already set up is left as it is, and every edited file is backed up.
#
#   ./install.sh              install or update everything
#   ./install.sh --dry-run    show what would change without changing anything
#   ./install.sh --help       all options
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BOOTSTRAP_MODE=install
# shellcheck source=scripts/bootstrap.sh
. "$REPO_DIR/scripts/bootstrap.sh"

exec "$NODE" "$REPO_DIR/scripts/setup.mjs" install ${1+"$@"}
