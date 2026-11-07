#!/bin/bash
# Undo install.sh: removes the Playwright MCP entry from every agent's config, the playwright-cli
# skills and the CLI's default-browser setting. Every edited file is backed up first.
#
#   ./uninstall.sh            remove the agent setup, keep Playwright and its browsers installed
#   ./uninstall.sh --all      also uninstall the npm packages and delete the downloaded browsers
#   ./uninstall.sh --dry-run  show what would be removed without changing anything
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BOOTSTRAP_MODE=uninstall
# shellcheck source=scripts/bootstrap.sh
. "$REPO_DIR/scripts/bootstrap.sh"

exec "$NODE" "$REPO_DIR/scripts/setup.mjs" uninstall ${1+"$@"}
