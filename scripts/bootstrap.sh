# Sourced by install.sh and uninstall.sh (bash 3.2 compatible, the version macOS ships).
# Finds Node.js 20+ (offering to install it with Homebrew), puts it on PATH, and installs this
# folder's own packages. Sets NODE. Expects REPO_DIR and BOOTSTRAP_MODE (install|uninstall).

say() { printf '%s\n' "$*"; }
fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }

ARGS=" ${*-} "
has_arg() { case "$ARGS" in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

if [ "$(uname -s)" != "Darwin" ]; then
  say "Note: this setup is written for macOS. App-specific steps may not apply on this system."
fi

find_node() {
  if command -v node >/dev/null 2>&1; then command -v node; return 0; fi
  # Shells started by apps or agents often lack the PATH your Terminal has.
  for dir in /opt/homebrew/bin /usr/local/bin "$HOME/.volta/bin" "$HOME/.local/share/mise/shims" "$HOME/.asdf/shims"; do
    if [ -x "$dir/node" ]; then printf '%s\n' "$dir/node"; return 0; fi
  done
  local nvm_sh="${NVM_DIR:-$HOME/.nvm}/nvm.sh"
  if [ -s "$nvm_sh" ]; then
    # shellcheck disable=SC1090
    . "$nvm_sh" >/dev/null 2>&1 || true
    if command -v node >/dev/null 2>&1; then command -v node; return 0; fi
  fi
  return 1
}

find_brew() {
  if command -v brew >/dev/null 2>&1; then command -v brew; return 0; fi
  for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    if [ -x "$b" ]; then printf '%s\n' "$b"; return 0; fi
  done
  return 1
}

NODE="$(find_node || true)"
if [ -z "$NODE" ]; then
  if [ "${BOOTSTRAP_MODE:-install}" = "uninstall" ]; then
    fail "Node.js isn't installed, so there are no npm packages to remove. To remove the config entries by hand, see README.md."
  fi
  NODE_HELP="Install Node.js 20 or newer (https://nodejs.org, or 'brew install node' with Homebrew from https://brew.sh), then run this again."
  BREW="$(find_brew || true)"
  if [ -z "$BREW" ] || has_arg --dry-run; then
    fail "Node.js isn't installed. $NODE_HELP"
  fi
  say "Node.js 20 or newer is needed and isn't installed."
  if has_arg --yes || has_arg -y; then
    answer=y
  elif [ -t 0 ]; then
    printf 'Install it now with Homebrew (brew install node)? [Y/n] '
    read -r answer || answer=n
  else
    fail "Node.js isn't installed. $NODE_HELP (Or re-run with --yes to let this script run 'brew install node'.)"
  fi
  case "${answer:-y}" in
    [Yy]*) "$BREW" install node || fail "brew install node failed." ;;
    *) fail "$NODE_HELP" ;;
  esac
  NODE="$(find_node || true)"
  [ -n "$NODE" ] || fail "Node.js still isn't on PATH after installing. Open a new Terminal window and run this again."
fi

PATH="$(dirname "$NODE"):$PATH"
export PATH

NODE_MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  fail "Node.js $("$NODE" -v) is too old; version 20 or newer is needed. Update it (for example 'brew upgrade node') and run this again."
fi
command -v npm >/dev/null 2>&1 || fail "npm wasn't found next to $NODE. Reinstall Node.js and run this again."

# This folder's own packages: the MCP client used for the final check, and a comment-preserving
# JSON editor for agent configs. Skipped when they're already installed.
if [ ! -f "$REPO_DIR/node_modules/jsonc-parser/package.json" ] || [ ! -f "$REPO_DIR/node_modules/@modelcontextprotocol/sdk/package.json" ]; then
  say "Installing this folder's packages (npm ci)…"
  (cd "$REPO_DIR" && npm ci --no-fund --no-audit --loglevel=error) || fail "npm ci failed in $REPO_DIR."
fi
