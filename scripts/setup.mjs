#!/usr/bin/env node
// Installs (or removes) Playwright browser automation for every AI agent on this Mac.
// Run it through ./install.sh or ./uninstall.sh: they make sure Node.js 20+ and this folder's
// packages exist first. Every config file is backed up to ~/.playwright/backups before it changes.

import { spawn, spawnSync } from "node:child_process";
import {
  accessSync, appendFileSync, constants, copyFileSync, existsSync, mkdirSync, mkdtempSync,
  readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { applyEdits, modify, parse, printParseErrorCode } from "jsonc-parser";

const SERVER = "playwright";
const PACKAGES = ["playwright", "@playwright/mcp", "@playwright/cli"];
const HOME = homedir();
const STATE_DIR = join(HOME, ".playwright");
const HELPER_LOG = join(STATE_DIR, "claude-desktop-config.log");
const SELF = fileURLToPath(import.meta.url);
const APP_SUPPORT = join(HOME, "Library", "Application Support");
const RUN_ID = new Date().toISOString().replace(/[:.]/g, "-");
const BACKUP_DIR = join(STATE_DIR, "backups", RUN_ID);

// What each --browser value means for the MCP server, the CLI config and the download step.
const BROWSERS = {
  chromium: { cli: { browserName: "chromium", channel: "chrome-for-testing" }, download: "chromium", label: "Playwright's Chromium" },
  chrome: { cli: { browserName: "chromium", channel: "chrome" }, system: "/Applications/Google Chrome.app", label: "Google Chrome" },
  msedge: { cli: { browserName: "chromium", channel: "msedge" }, system: "/Applications/Microsoft Edge.app", label: "Microsoft Edge" },
  firefox: { cli: { browserName: "firefox" }, download: "firefox", label: "Playwright's Firefox" },
  webkit: { cli: { browserName: "webkit" }, download: "webkit", label: "Playwright's WebKit" },
};

const help = () => `Usage: ./install.sh [options]    |    ./uninstall.sh [options]

Sets up Playwright browser automation for the AI agents on this Mac. Safe to run again:
anything already set up is left alone, and every edited file is backed up to ~/.playwright/backups.

Options:
  --dry-run          show what would change, change nothing
  --browser <name>   chromium (default: Playwright's own), chrome, msedge, firefox, webkit
  --headless         register the browser without a visible window (for background agents)
  --only <ids>       only connect (or disconnect) these agents, comma-separated; skips the
                     package, browser, CLI-config and skill steps
  --skip <ids>       every agent except these
  --no-npm           don't install or update the npm packages
  --no-browsers      don't download browsers
  --no-skills        don't install the playwright-cli skill files
  --no-verify        skip the final check that the browser starts
  --no-wait          if Claude Desktop is open, don't leave a helper waiting for it to quit
  -y, --yes          don't ask questions
  --all              uninstall only: also remove the npm packages and downloaded browsers
  -h, --help

Agent ids: ${CLIENTS.map((c) => c.id).join(", ")}`;

let opt;
let mode;
try {
  const parsed = parseArgs({
    allowPositionals: true,
    options: {
      "dry-run": { type: "boolean", default: false },
      browser: { type: "string", default: "chromium" },
      headless: { type: "boolean", default: false },
      only: { type: "string" },
      skip: { type: "string" },
      "no-npm": { type: "boolean", default: false },
      "no-browsers": { type: "boolean", default: false },
      "no-skills": { type: "boolean", default: false },
      "no-verify": { type: "boolean", default: false },
      "no-wait": { type: "boolean", default: false },
      yes: { type: "boolean", short: "y", default: false },
      all: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      // used by the Claude Desktop helper process
      entry: { type: "string" },
      remove: { type: "boolean", default: false },
    },
  });
  opt = parsed.values;
  mode = parsed.positionals[0];
} catch (err) {
  console.error(`${err.message}\nRun ./install.sh --help for the options.`);
  process.exit(2);
}
const DRY = opt["dry-run"];

// ---------- output ----------

const tty = process.stdout.isTTY;
const paint = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const bold = paint(1);
const dim = paint(2);
const green = paint(32);
const yellow = paint(33);
const red = paint(31);
const say = (s = "") => console.log(s);
const heading = (s) => say(`\n${bold(s)}`);
const ok = (s) => say(`  ${green("✔")} ${s}`);
const info = (s) => say(`  ${dim("•")} ${s}`);
const warn = (s) => say(`  ${yellow("!")} ${s}`);
const bad = (s) => say(`  ${red("✖")} ${s}`);
const tilde = (p) => (p && p.startsWith(HOME) ? `~${p.slice(HOME.length)}` : p);

class Fatal extends Error {}

// ---------- processes and files ----------

function run(cmd, args, { cwd, timeout = 120_000, inherit = false } = {}) {
  const r = spawnSync(cmd, args, {
    cwd, timeout, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
  });
  return {
    code: r.error ? -1 : r.status ?? -1,
    stdout: r.stdout ?? "",
    out: `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? r.error.message : ""}`.trim(),
  };
}

function mustRun(cmd, args, options) {
  const r = run(cmd, args, options);
  if (r.code !== 0) throw new Error(`${tilde(cmd)} ${args.slice(0, 3).join(" ")} … failed: ${r.out.split("\n").slice(-3).join(" ")}`);
  return r;
}

// In a dry run, say what would happen instead of doing it.
function change(description, fn) {
  if (DRY) {
    info(`${dim("would")} ${description}`);
    return;
  }
  return fn();
}

const isExecutable = (p) => {
  try {
    accessSync(p, constants.X_OK);
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

function which(name) {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir && isExecutable(join(dir, name))) return join(dir, name);
  }
}

function canWrite(dir) {
  let d = dir;
  while (!existsSync(d) && dirname(d) !== d) d = dirname(d);
  try {
    accessSync(d, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

const backedUp = new Set();
function backup(file) {
  if (backedUp.has(file) || !existsSync(file)) return;
  mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
  copyFileSync(file, join(BACKUP_DIR, tilde(file).replace(/^~\//, "").replace(/\//g, "__")));
  backedUp.add(file);
}

// Write through symlinks (dotfile managers) and keep the file's permissions.
function writeAtomic(file, text) {
  const target = existsSync(file) ? realpathSync(file) : file;
  mkdirSync(dirname(target), { recursive: true });
  const mode = existsSync(target) ? statSync(target).mode & 0o777 : 0o644;
  const tmp = `${target}.tmp-${process.pid}`;
  writeFileSync(tmp, text, { mode });
  renameSync(tmp, target);
}

function readJsonc(file) {
  if (!existsSync(file)) return { exists: false, text: "", data: undefined };
  const text = readFileSync(file, "utf8");
  if (!text.trim()) return { exists: true, text: "", data: undefined };
  const errors = [];
  const data = parse(text, errors, { allowTrailingComma: true });
  if (errors.length) {
    throw new Error(`${tilde(file)} has a syntax error (${printParseErrorCode(errors[0].error)} at character ${errors[0].offset}), so it was left alone`);
  }
  return { exists: true, text, data };
}

const getPath = (obj, path) => path.reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), obj);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function indentOf(text) {
  const m = text.match(/^([ \t]+)\S/m);
  if (!m) return { insertSpaces: true, tabSize: 2 };
  return m[1].startsWith("\t") ? { insertSpaces: false, tabSize: 1 } : { insertSpaces: true, tabSize: m[1].length };
}

// Set (or with value undefined, remove) one key in a JSON/JSONC file, keeping comments and layout.
// Returns "unchanged" | "added" | "updated" | "removed".
function setJsonc(file, path, value) {
  const { text, data } = readJsonc(file);
  const current = getPath(data, path);
  if (same(current, value)) return "unchanged";
  if (value === undefined && current === undefined) return "unchanged";
  const base = text.trim() ? text : "{}\n";
  if (data !== undefined && (typeof data !== "object" || Array.isArray(data))) {
    throw new Error(`${tilde(file)} isn't a JSON object, so it was left alone`);
  }
  const next = applyEdits(base, modify(base, path, value, { formattingOptions: { ...indentOf(base), eol: "\n" } }));
  if (!same(getPath(parse(next), path), value)) throw new Error(`editing ${tilde(file)} went wrong, so it was left alone`);
  const result = value === undefined ? "removed" : current === undefined ? "added" : "updated";
  change(`${result === "removed" ? "remove" : result === "added" ? "add" : "update"} "${path.join(".")}" in ${tilde(file)}`, () => {
    backup(file);
    writeAtomic(file, next.endsWith("\n") ? next : `${next}\n`);
  });
  return result;
}

const readJsonFile = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
};

// ---------- environment ----------

// Prefer a path that survives Node upgrades (Homebrew's bin/node symlink) over a versioned one.
function stableNodePath() {
  const real = realpathSync(process.execPath);
  for (const candidate of [which("node"), "/opt/homebrew/bin/node", "/usr/local/bin/node"]) {
    if (!candidate) continue;
    try {
      if (realpathSync(candidate) === real) return candidate;
    } catch {}
  }
  return process.execPath;
}

function environment() {
  const node = stableNodePath();
  const npm = which("npm");
  if (!npm) throw new Fatal("npm isn't on PATH. Reinstall Node.js and run this again.");
  const npmRoot = run(npm, ["root", "-g"]).stdout.trim();
  if (!npmRoot) throw new Fatal("Couldn't find npm's global folder (npm root -g).");
  return { node, npm, npmRoot };
}

function packageVersion(env, pkg) {
  return readJsonFile(join(env.npmRoot, pkg, "package.json"))?.version;
}

function binScript(env, pkg, name) {
  const dir = join(env.npmRoot, pkg);
  const bin = readJsonFile(join(dir, "package.json"))?.bin;
  const rel = typeof bin === "string" ? bin : bin?.[name];
  return rel ? join(dir, rel) : undefined;
}

// The playwright-core a package uses decides which browser build it needs.
function playwrightCore(env, pkg) {
  for (const dir of [join(env.npmRoot, pkg, "node_modules", "playwright-core"), join(env.npmRoot, "playwright-core")]) {
    const version = readJsonFile(join(dir, "package.json"))?.version;
    if (version && existsSync(join(dir, "cli.js"))) return { version, cli: join(dir, "cli.js") };
  }
}

// ---------- agent apps ----------

const APP = (name) => [join("/Applications", name), join(HOME, "Applications", name)].some((p) => existsSync(p));
const CLAUDE_DESKTOP_CONFIG = join(APP_SUPPORT, "Claude", "claude_desktop_config.json");

function newestBundledClaude() {
  const root = join(APP_SUPPORT, "Claude", "claude-code");
  if (!existsSync(root)) return;
  const versions = readdirSync(root).filter((v) => /^\d+(\.\d+)*$/.test(v));
  versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const v of versions) {
    for (const hash of readdirSync(join(root, v))) {
      const bin = join(root, v, hash, "claude.app", "Contents", "MacOS", "claude");
      if (isExecutable(bin)) return bin;
    }
  }
}

function findClaude() {
  return [which("claude"), join(HOME, ".local/bin/claude"), join(HOME, ".claude/local/claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude", newestBundledClaude()]
    .find((p) => p && isExecutable(p));
}

function findCodex() {
  return [which("codex"), "/opt/homebrew/bin/codex", "/usr/local/bin/codex",
    "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
    "/Applications/Codex.app/Contents/Resources/codex"]
    .find((p) => p && isExecutable(p));
}

function findOpencode() {
  return [which("opencode"), join(HOME, ".local/bin/opencode"), join(HOME, ".opencode/bin/opencode"), "/opt/homebrew/bin/opencode", "/usr/local/bin/opencode"]
    .find((p) => p && isExecutable(p));
}

const isOurs = (value) => JSON.stringify(value ?? "").includes("@playwright/mcp") || JSON.stringify(value ?? "").includes("playwright-mcp");
const sameCommand = (a, b) => a && b && a.command === b.command && same(a.args ?? [], b.args ?? []);

// Clients that are a JSON key in a file. shape() turns the {command, args} entry into the
// client's own format.
function jsonClient({ id, name, file, path, shape, present, after }) {
  return {
    id, name, present,
    install(entry) {
      const f = file();
      const result = setJsonc(f, path, shape(entry));
      return { status: result === "unchanged" ? "already set" : result, where: tilde(f), after: result === "unchanged" ? undefined : after };
    },
    uninstall() {
      const f = file();
      const current = getPath(readJsonc(f).data, path);
      if (current === undefined) return { status: "not set", where: tilde(f) };
      if (!isOurs(current)) return { status: "left alone", detail: `its "${SERVER}" entry wasn't added by this setup`, where: tilde(f) };
      setJsonc(f, path, undefined);
      return { status: "removed", where: tilde(f), after };
    },
  };
}

const CLIENTS = [
  {
    id: "claude-code",
    name: "Claude Code",
    present: () => !!findClaude() || existsSync(join(HOME, ".claude.json")),
    install(entry) {
      const bin = findClaude();
      if (!bin) return manual(`add it with: claude mcp add --scope user ${SERVER} -- ${entry.command} ${entry.args.join(" ")}`);
      const current = readJsonFile(join(HOME, ".claude.json"))?.mcpServers?.[SERVER];
      if (sameCommand(current, entry)) return { status: "already set", where: "~/.claude.json (user scope)" };
      if (current) change(`remove the old "${SERVER}" entry from Claude Code`, () => mustRun(bin, ["mcp", "remove", SERVER, "-s", "user"]));
      change(`run: claude mcp add --scope user ${SERVER} -- …`, () => mustRun(bin, ["mcp", "add", "--scope", "user", SERVER, "--", entry.command, ...entry.args]));
      return { status: current ? "updated" : "added", where: "~/.claude.json (user scope)", after: "start a new Claude Code session to see it" };
    },
    uninstall() {
      const bin = findClaude();
      const current = readJsonFile(join(HOME, ".claude.json"))?.mcpServers?.[SERVER];
      if (!current) return { status: "not set" };
      if (!isOurs(current)) return { status: "left alone", detail: "that entry wasn't added by this setup" };
      if (!bin) return manual(`remove it with: claude mcp remove ${SERVER} -s user`);
      change(`run: claude mcp remove ${SERVER} -s user`, () => mustRun(bin, ["mcp", "remove", SERVER, "-s", "user"]));
      return { status: "removed", where: "~/.claude.json (user scope)" };
    },
  },
  {
    id: "claude-desktop",
    name: "Claude Desktop",
    present: () => APP("Claude.app") || existsSync(dirname(CLAUDE_DESKTOP_CONFIG)),
    install: (entry) => claudeDesktop({ command: entry.command, args: entry.args }),
    uninstall: () => claudeDesktop(undefined),
  },
  {
    id: "codex",
    name: "Codex",
    present: () => !!findCodex() || existsSync(join(process.env.CODEX_HOME ?? join(HOME, ".codex"), "config.toml")),
    install(entry) {
      const bin = findCodex();
      if (!bin) return manual(`add it with: codex mcp add ${SERVER} -- ${entry.command} ${entry.args.join(" ")}`);
      const current = codexGet(bin);
      if (sameCommand(current, entry)) return { status: "already set", where: "~/.codex/config.toml" };
      if (current) change(`run: codex mcp remove ${SERVER}`, () => mustRun(bin, ["mcp", "remove", SERVER]));
      change(`run: codex mcp add ${SERVER} -- …`, () => mustRun(bin, ["mcp", "add", SERVER, "--", entry.command, ...entry.args]));
      return { status: current ? "updated" : "added", where: "~/.codex/config.toml", after: "start a new Codex session to see it" };
    },
    uninstall() {
      const bin = findCodex();
      if (!bin) return manual(`remove the [mcp_servers.${SERVER}] table from ~/.codex/config.toml`);
      const current = codexGet(bin);
      if (!current) return { status: "not set" };
      if (!isOurs(current)) return { status: "left alone", detail: "that entry wasn't added by this setup" };
      change(`run: codex mcp remove ${SERVER}`, () => mustRun(bin, ["mcp", "remove", SERVER]));
      return { status: "removed", where: "~/.codex/config.toml" };
    },
  },
  {
    id: "opencode",
    name: "OpenCode",
    present: () => !!findOpencode() || existsSync(opencodeDir()),
    install: (entry) => opencode(entry),
    uninstall: () => opencode(undefined),
  },
  // __MORE_CLIENTS__
];

function manual(detail) {
  return { status: "manual", detail };
}

// codex mcp get prints "  command: …" and "  args: …" lines.
function codexGet(bin) {
  const r = run(bin, ["mcp", "get", SERVER]);
  if (r.code !== 0) return undefined;
  const field = (k) => r.stdout.match(new RegExp(`^\\s*${k}:\\s*(.*)$`, "m"))?.[1]?.trim();
  const command = field("command");
  const args = field("args");
  return command ? { command, args: args && args !== "-" ? args.split(/\s+/) : [] } : undefined;
}

function opencodeDir() {
  return join(process.env.XDG_CONFIG_HOME ?? join(HOME, ".config"), "opencode");
}

function opencode(entry) {
  const dir = opencodeDir();
  const file = ["opencode.jsonc", "opencode.json"].map((f) => join(dir, f)).find(existsSync) ?? join(dir, "opencode.json");
  const bin = findOpencode();
  const version = bin ? run(bin, ["--version"]).out.match(/(\d+)\.\d+\.\d+/)?.[1] : undefined;
  // OpenCode 2 keeps servers under mcp.servers; older versions put them directly under mcp.
  const legacy = version !== undefined && Number(version) < 2;
  const path = legacy ? ["mcp", SERVER] : ["mcp", "servers", SERVER];
  const value = entry && { type: "local", command: [entry.command, ...entry.args], ...(legacy ? { enabled: true } : {}) };
  const current = getPath(readJsonc(file).data, path);
  if (!entry) {
    if (current === undefined) return { status: "not set", where: tilde(file) };
    if (!isOurs(current)) return { status: "left alone", detail: "that entry wasn't added by this setup", where: tilde(file) };
  }
  const result = setJsonc(file, path, value);
  return { status: result === "unchanged" ? "already set" : result, where: tilde(file), after: result === "unchanged" ? undefined : "start a new OpenCode session to see it" };
}

// ---------- Claude Desktop ----------
// The running app keeps its config in memory and writes it back over outside edits, so the
// change is made while the app is closed: now, or by a small helper that waits for it to quit.

// pgrep can miss the main app process (it does inside agent sandboxes), so ask ps and
// LaunchServices; either one seeing the app counts as running.
function claudeDesktopRunning() {
  const forced = process.env.PLAYWRIGHT_SETUP_CLAUDE_DESKTOP_RUNNING; // for tests: "1" or "0"
  if (forced === "1" || forced === "0") return forced === "1";
  const ps = run("/bin/ps", ["-axo", "comm="]);
  if (/\/Claude\.app\/Contents\/MacOS\/Claude$/m.test(ps.stdout)) return true;
  const apps = run("/usr/bin/lsappinfo", ["find", "bundleID=com.anthropic.claudefordesktop"]);
  return apps.stdout.trim().length > 0;
}

function claudeDesktop(entry) {
  const where = tilde(CLAUDE_DESKTOP_CONFIG);
  if (!entry) stopClaudeDesktopHelpers(); // a pending "add" would undo the removal
  const current = getPath(readJsonc(CLAUDE_DESKTOP_CONFIG).data, ["mcpServers", SERVER]);
  if (!entry && current === undefined) return { status: "not set", where };
  if (!entry && !isOurs(current)) return { status: "left alone", detail: "that entry wasn't added by this setup", where };
  if (entry && sameCommand(current, entry)) return { status: "already set", where };
  if (!claudeDesktopRunning()) {
    const result = setJsonc(CLAUDE_DESKTOP_CONFIG, ["mcpServers", SERVER], entry);
    return { status: result, where, after: "open Claude Desktop" };
  }
  if (opt["no-wait"]) {
    return manual(`Claude Desktop is open. Quit it (⌘Q), then run ./${entry ? "install" : "uninstall"}.sh --only claude-desktop`);
  }
  change(`wait in the background for Claude Desktop to quit, then ${entry ? "add" : "remove"} "${SERVER}"`, () => startClaudeDesktopHelper(entry));
  return { status: "pending", where, after: "quit Claude Desktop (⌘Q) and open it again" };
}

// Helpers are tracked by a pid file in this home's ~/.playwright, so a run for another home
// (another user, or a test) never touches this one's helper.
const HELPER_PID = join(STATE_DIR, "claude-desktop-helper.pid");
const LEGACY_HELPER = join(STATE_DIR, "add-to-claude-desktop.mjs"); // left by the first, manual setup
const commandLine = (pid) => run("/bin/ps", ["-o", "command=", "-p", String(pid)]).stdout.trim();

function stopClaudeDesktopHelpers() {
  if (DRY) return;
  const pid = existsSync(HELPER_PID) ? Number(readFileSync(HELPER_PID, "utf8").trim()) : 0;
  if (pid && pid !== process.pid && commandLine(pid).includes("claude-desktop-helper")) {
    try {
      process.kill(pid);
    } catch {}
  }
  rmSync(HELPER_PID, { force: true });
  if (existsSync(LEGACY_HELPER)) {
    for (const line of run("/bin/ps", ["-axo", "pid=,command="]).stdout.split("\n")) {
      const m = line.match(/^\s*(\d+)\s+(.*)$/);
      if (m && m[2].includes(LEGACY_HELPER)) {
        try {
          process.kill(Number(m[1]));
        } catch {}
      }
    }
    rmSync(LEGACY_HELPER, { force: true });
  }
}

function startClaudeDesktopHelper(entry) {
  stopClaudeDesktopHelpers();
  mkdirSync(STATE_DIR, { recursive: true });
  const payload = Buffer.from(JSON.stringify(entry ?? null)).toString("base64");
  const child = spawn(process.execPath, [SELF, "claude-desktop-helper", "--entry", payload], { detached: true, stdio: "ignore" });
  writeFileSync(HELPER_PID, String(child.pid));
  child.unref();
}

async function claudeDesktopHelper() {
  const entry = JSON.parse(Buffer.from(opt.entry ?? "", "base64").toString() || "null") ?? undefined;
  mkdirSync(STATE_DIR, { recursive: true });
  const note = (m) => appendFileSync(HELPER_LOG, `${new Date().toISOString()} ${m}\n`);
  note(`waiting for Claude Desktop to quit, then ${entry ? "adding" : "removing"} "${SERVER}"`);
  const giveUpAt = Date.now() + 14 * 24 * 3600 * 1000;
  try {
    while (claudeDesktopRunning()) {
      if (Date.now() > giveUpAt) return note("gave up after 14 days without Claude Desktop quitting");
      await new Promise((r) => setTimeout(r, 2000));
    }
    const result = setJsonc(CLAUDE_DESKTOP_CONFIG, ["mcpServers", SERVER], entry);
    note(`${result}: "${SERVER}" in claude_desktop_config.json; it takes effect when Claude Desktop opens`);
  } catch (err) {
    note(`failed: ${err.message}`);
  } finally {
    if (existsSync(HELPER_PID) && readFileSync(HELPER_PID, "utf8").trim() === String(process.pid)) rmSync(HELPER_PID, { force: true });
  }
}

// ---------- steps ----------

function selectedClients() {
  const ids = new Set(CLIENTS.map((c) => c.id));
  const list = (s) => (s ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  for (const id of [...list(opt.only), ...list(opt.skip)]) {
    if (!ids.has(id)) throw new Fatal(`Unknown agent id "${id}". Known ids: ${[...ids].join(", ")}`);
  }
  const only = new Set(list(opt.only));
  const skip = new Set(list(opt.skip));
  return CLIENTS.filter((c) => (!only.size || only.has(c.id)) && !skip.has(c.id));
}

function installPackages(env) {
  heading("Playwright packages");
  if (!canWrite(env.npmRoot)) {
    throw new Fatal(
      `npm can't write to ${env.npmRoot}. Don't use sudo: install Node with Homebrew (brew install node) ` +
        "or a version manager such as nvm, or point npm at a folder you own (npm config set prefix ~/.npm-global).",
    );
  }
  const before = Object.fromEntries(PACKAGES.map((p) => [p, packageVersion(env, p)]));
  const specs = PACKAGES.map((p) => `${p}@latest`);
  if (DRY) {
    for (const p of PACKAGES) info(`${p}: ${before[p] ? `${before[p]} installed` : "not installed"}`);
    info(`${dim("would")} run: npm install -g ${specs.join(" ")}`);
    return;
  }
  const r = run(env.npm, ["install", "-g", ...specs, "--no-fund", "--no-audit"], { inherit: true, timeout: 900_000 });
  if (r.code !== 0) throw new Fatal("npm install -g failed (see the messages above).");
  for (const p of PACKAGES) {
    const now = packageVersion(env, p);
    ok(`${p} ${now}${before[p] && before[p] !== now ? dim(` (was ${before[p]})`) : ""}`);
  }
}

function installBrowsers(env) {
  heading("Browser");
  const choice = BROWSERS[opt.browser];
  if (choice.system) {
    if (existsSync(choice.system)) ok(`${choice.label} is installed`);
    else warn(`${choice.label} isn't installed. Install it, or run again with --browser chromium.`);
    return;
  }
  const cores = new Map();
  for (const p of PACKAGES) {
    const core = playwrightCore(env, p);
    if (core) cores.set(core.version, core.cli);
  }
  if (!cores.size) return warn(DRY ? "packages aren't installed yet; the browser would be downloaded after them" : "couldn't find playwright-core; skipping the download");
  for (const [version, cli] of cores) {
    const plan = run(env.node, [cli, "install", "--dry-run", choice.download]).out;
    const dirs = [...plan.matchAll(/Install location:\s+(\S.*)$/gm)].map((m) => m[1].trim());
    const missing = dirs.filter((d) => !existsSync(d));
    if (dirs.length && !missing.length) {
      ok(`${choice.label} for playwright-core ${version} is already downloaded`);
      continue;
    }
    change(`download ${choice.label} for playwright-core ${version}`, () => {
      const r = run(env.node, [cli, "install", choice.download], { inherit: true, timeout: 1_800_000 });
      if (r.code !== 0) throw new Fatal(`Downloading ${choice.label} failed (see above). Check the network and run this again.`);
      ok(`${choice.label} for playwright-core ${version} downloaded`);
    });
  }
}

function configureCli() {
  heading("Playwright CLI default browser");
  const file = join(STATE_DIR, "cli.config.json");
  const { browserName, channel } = BROWSERS[opt.browser].cli;
  const a = setJsonc(file, ["browser", "browserName"], browserName);
  const b = setJsonc(file, ["browser", "launchOptions", "channel"], channel);
  if (a === "unchanged" && b === "unchanged") ok(`already ${BROWSERS[opt.browser].label} (${tilde(file)})`);
  else if (!DRY) ok(`set to ${BROWSERS[opt.browser].label} in ${tilde(file)}`);
}

const SKILL_DIRS = { claude: join(HOME, ".claude", "skills", "playwright-cli"), agents: join(HOME, ".agents", "skills", "playwright-cli") };

function installSkills(env) {
  heading("playwright-cli skill for coding agents");
  const cli = binScript(env, "@playwright/cli", "playwright-cli");
  if (!cli || !existsSync(cli)) return warn(DRY ? "would install after the packages" : "playwright-cli isn't installed; skipping");
  const targets = [];
  if (existsSync(join(HOME, ".claude")) || findClaude()) targets.push("claude");
  if (existsSync(join(HOME, ".agents")) || findCodex() || findOpencode()) targets.push("agents");
  if (!targets.length) return info("no coding agent that reads skills was found");
  const cwd = mkdtempSync(join(tmpdir(), "pw-skills-"));
  try {
    for (const t of targets) {
      change(`install the playwright-cli skill into ${tilde(SKILL_DIRS[t])}`, () => {
        mustRun(env.node, [cli, "install", "--skills", t, "--global"], { cwd });
        ok(`skill in ${tilde(SKILL_DIRS[t])}`);
      });
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

function connectAgents(entry, action) {
  heading(action === "install" ? "Connecting agents" : "Disconnecting agents");
  const results = [];
  for (const client of selectedClients()) {
    let r;
    try {
      r = client.present() ? client[action](entry) : { status: "not installed" };
    } catch (err) {
      r = { status: "failed", detail: err.message };
    }
    results.push({ name: client.name, ...r });
    const DRY_WORDING = { added: "would be added", updated: "would be updated", removed: "would be removed", pending: "would wait for Claude Desktop to quit" };
    const status = (DRY && DRY_WORDING[r.status]) || r.status;
    const line = `${client.name}: ${status}${r.detail ? dim(` (${r.detail})`) : ""}`;
    if (["failed"].includes(r.status)) bad(line);
    else if (["manual", "pending", "left alone"].includes(r.status)) warn(line);
    else if (["not installed", "not set"].includes(r.status)) info(dim(line));
    else ok(line);
  }
  return results;
}

async function verify(env, entry) {
  heading("Checking that it works");
  const work = mkdtempSync(join(tmpdir(), "pw-check-"));
  let passed = true;
  try {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    const client = new Client({ name: "playwright-setup-check", version: "1.0.0" });
    const args = [...entry.args.filter((a) => a !== "--headless"), "--headless", "--isolated", "--output-dir", work];
    await client.connect(new StdioClientTransport({ command: entry.command, args, cwd: work, stderr: "ignore" }));
    try {
      const { tools } = await client.listTools();
      const nav = await client.callTool({ name: "browser_navigate", arguments: { url: "about:blank" } }, undefined, { timeout: 120_000 });
      if (nav.isError) throw new Error(nav.content?.map((p) => p.text).join(" ").slice(0, 300));
      await client.callTool({ name: "browser_close", arguments: {} }).catch(() => {});
      ok(`MCP server started ${BROWSERS[opt.browser].label} (${tools.length} browser tools)`);
    } finally {
      await client.close().catch(() => {});
    }
  } catch (err) {
    passed = false;
    bad(`MCP server check failed: ${err.message}`);
  }
  const cli = binScript(env, "@playwright/cli", "playwright-cli");
  if (cli && existsSync(cli)) {
    const opened = run(env.node, [cli, "-s=setup-check", "open", "about:blank"], { cwd: work, timeout: 180_000 });
    run(env.node, [cli, "-s=setup-check", "close"], { cwd: work });
    if (opened.code === 0) ok("playwright-cli opened the browser");
    else {
      passed = false;
      bad(`playwright-cli check failed: ${opened.out.split("\n").slice(-2).join(" ")}`);
    }
  }
  rmSync(work, { recursive: true, force: true });
  return passed;
}

function summary(results, entry) {
  heading(DRY ? "Dry run finished: nothing was changed" : "Done");
  const todo = results.filter((r) => r.after).map((r) => `${r.name}: ${r.after}`);
  const manualSteps = results.filter((r) => r.status === "manual").map((r) => `${r.name}: ${r.detail}`);
  if (todo.length || manualSteps.length) {
    say("\nNext steps:");
    for (const t of [...todo, ...manualSteps]) say(`  - ${t}`);
  }
  if (entry) {
    say(`\nAny other MCP client can use this server:\n${dim(JSON.stringify({ mcpServers: { [SERVER]: entry } }, null, 2))}`);
    say(`\nOpen-source models through any OpenAI-compatible server: node browser-agent.mjs "your task"`);
  }
  if (backedUp.size) say(`\nBackups of the files that changed: ${tilde(BACKUP_DIR)}`);
}

// ---------- install / uninstall ----------

async function install() {
  if (!BROWSERS[opt.browser]) throw new Fatal(`--browser must be one of: ${Object.keys(BROWSERS).join(", ")}`);
  selectedClients(); // reject unknown --only / --skip ids before changing anything
  const agentsOnly = !!opt.only;
  heading(`Playwright for AI agents${DRY ? dim("  (dry run: nothing will change)") : ""}`);
  const env = environment();
  info(`Node.js ${process.version} at ${env.node}`);
  if (/\/(\.nvm|\.fnm|fnm_multishells|\.volta|mise|\.asdf)\//.test(env.node)) {
    warn("Node comes from a version manager. Agent configs will point at this exact Node; if you remove or switch it, run ./install.sh again.");
  }
  if (!opt["no-npm"] && !agentsOnly) installPackages(env);
  const mcpCli = join(env.npmRoot, "@playwright", "mcp", "cli.js");
  if (!existsSync(mcpCli) && !DRY) {
    throw new Fatal(`Playwright MCP isn't installed at ${mcpCli}. Run ./install.sh without --no-npm or --only first.`);
  }
  if (!agentsOnly) {
    if (!opt["no-browsers"]) installBrowsers(env);
    configureCli();
    if (!opt["no-skills"]) installSkills(env);
  }
  const entry = { command: env.node, args: [mcpCli, "--browser", opt.browser, ...(opt.headless ? ["--headless"] : [])] };
  const results = connectAgents(entry, "install");
  let passed = true;
  if (!opt["no-verify"] && !DRY) passed = await verify(env, entry);
  summary(results, entry);
  return results.some((r) => r.status === "failed") || !passed ? 1 : 0;
}

async function uninstall() {
  selectedClients();
  heading(`Removing the Playwright setup${DRY ? dim("  (dry run: nothing will change)") : ""}`);
  const env = environment();
  const results = connectAgents(undefined, "uninstall");
  if (opt.only) {
    summary(results, undefined);
    return results.some((r) => r.status === "failed") ? 1 : 0;
  }

  heading("Skills and CLI config");
  for (const dir of Object.values(SKILL_DIRS)) {
    if (!existsSync(dir)) continue;
    const skill = existsSync(join(dir, "SKILL.md")) ? readFileSync(join(dir, "SKILL.md"), "utf8") : "";
    if (!/^name:\s*playwright-cli\s*$/m.test(skill)) {
      warn(`${tilde(dir)} doesn't look like the playwright-cli skill; left alone`);
      continue;
    }
    change(`delete ${tilde(dir)}`, () => {
      rmSync(dir, { recursive: true, force: true });
      ok(`removed ${tilde(dir)}`);
    });
  }
  const cliConfig = join(STATE_DIR, "cli.config.json");
  if (existsSync(cliConfig)) {
    const data = readJsonc(cliConfig).data ?? {};
    const onlyOurs = Object.keys(data).every((k) => k === "browser") && Object.keys(data.browser ?? {}).every((k) => ["browserName", "launchOptions"].includes(k)) && Object.keys(data.browser?.launchOptions ?? {}).every((k) => k === "channel");
    if (onlyOurs) {
      change(`delete ${tilde(cliConfig)}`, () => {
        backup(cliConfig);
        rmSync(cliConfig);
        ok(`removed ${tilde(cliConfig)}`);
      });
    } else {
      setJsonc(cliConfig, ["browser", "launchOptions", "channel"], undefined);
      setJsonc(cliConfig, ["browser", "browserName"], undefined);
      ok(`removed the default-browser setting from ${tilde(cliConfig)}`);
    }
  }

  if (opt.all) {
    heading("Packages and browsers");
    const core = playwrightCore(env, "playwright") ?? playwrightCore(env, "@playwright/mcp");
    if (core) {
      change("delete the browsers Playwright downloaded (all versions)", () => {
        run(env.node, [core.cli, "uninstall", "--all"], { inherit: true });
      });
    }
    const installed = PACKAGES.filter((p) => packageVersion(env, p));
    if (installed.length) {
      change(`run: npm uninstall -g ${installed.join(" ")}`, () => {
        mustRun(env.npm, ["uninstall", "-g", ...installed], { timeout: 600_000 });
        ok(`uninstalled ${installed.join(", ")}`);
      });
    }
  }
  summary(results, undefined);
  return results.some((r) => r.status === "failed") ? 1 : 0;
}

async function main() {
  if (mode === "claude-desktop-helper") return claudeDesktopHelper();
  if (opt.help || !["install", "uninstall"].includes(mode)) {
    say(help());
    return opt.help ? 0 : 2;
  }
  return mode === "install" ? install() : uninstall();
}

try {
  process.exitCode = (await main()) ?? 0;
} catch (err) {
  if (err instanceof Fatal) {
    console.error(`\n${red("Stopped:")} ${err.message}`);
    process.exitCode = 1;
  } else throw err;
}
