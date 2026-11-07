# Playwright for every agent

Playwright is installed on this Mac and wired into every agent you have, so Claude, Codex,
and open-source models can open pages, read them, click, type, fill forms, take screenshots,
and work with tabs in a real browser.

## What is installed

| Piece | Version | What it is for |
|---|---|---|
| `@playwright/mcp` (`playwright-mcp`) | 0.0.84 | MCP server with 25 browser tools. Any MCP client can use it. |
| `@playwright/cli` (`playwright-cli`) | 0.1.23 | The same tools as shell commands. Coding agents use fewer tokens with it than with MCP. |
| `playwright` | 1.65.0 | The library and test runner, for scripts and tests your agents write. |
| Chromium (Chrome for Testing 157 and 158) | | Saved in `~/Library/Caches/ms-playwright`. |

Google Chrome isn't installed, so everything uses Playwright's own Chromium (`--browser chromium`).
Without that flag Playwright looks for Google Chrome and fails.

## Who can use it

| Agent / model | How it connects | Configured in |
|---|---|---|
| **Claude Desktop** (chat) | MCP | `~/Library/Application Support/Claude/claude_desktop_config.json`. The entry is added the next time you quit the app (see below). |
| **Claude Code** (all projects) | MCP, plus the `playwright-cli` skill | `~/.claude.json` (user scope), `~/.claude/skills/playwright-cli` |
| **Codex** (ChatGPT app) | MCP, plus the `playwright-cli` skill | `~/.codex/config.toml`, `~/.agents/skills/playwright-cli` |
| **OpenCode + Ollama** (`qwen3.8:27b`, local and free) | MCP | `~/.config/opencode/opencode.jsonc` |
| **Any other MCP client** (LM Studio, Jan, Cursor, VS Code, Cline, Continue, Goose, Open WebUI, agent frameworks) | Paste [mcp.json](mcp.json), or connect by URL with [start-mcp-http.sh](start-mcp-http.sh) | Your client |
| **Any OpenAI-compatible model server** (Ollama, LM Studio, llama.cpp, vLLM, OpenRouter, OpenAI) | [browser-agent.mjs](browser-agent.mjs) in this folder | Command-line flags |
| **Any agent that can run shell commands** | `playwright-cli` | `~/.playwright/cli.config.json` |

## Using it

**Claude Desktop.** Quit the app with ⌘Q and open it again. While it runs, the app keeps its config in
memory and overwrites outside edits. So a one-time helper (`~/.playwright/add-to-claude-desktop.mjs`)
adds the entry right after the app quits, then deletes itself. Its log is `~/.playwright/claude-desktop-config.log`.
After reopening, ask, for example: *"Use the Playwright browser to open news.ycombinator.com and list the
top 5 stories."* A Chromium window opens so you can watch and step in.

If the helper never ran (for example, the Mac restarted first), quit Claude and run
`node ~/.playwright/add-to-claude-desktop.mjs` in Terminal. If that file is gone, paste the block from
[mcp.json](mcp.json) into the config file while Claude is closed.

**Claude Code.** It's available in every project. Ask in plain words: *"open localhost:3000 with
playwright and check the signup form works"*. The `playwright-cli` skill gives Claude Code a
lower-token route for long sessions.

**Codex.** Ask in plain words, the same way as Claude Code. Codex also has its own browser
and computer-use plugins. Playwright is an additional option.

**OpenCode with your local model:**

```bash
opencode run --auto "Use the playwright browser tools to open https://example.com and tell me the page title"
```

**Any OpenAI-compatible model** (local or hosted). Run `npm install` once in this folder, then:

```bash
node browser-agent.mjs "Open https://news.ycombinator.com and list the top 3 stories"
```

| Option | Example |
|---|---|
| Use a different local server | `--provider lmstudio`, `--provider llamacpp`, `--provider vllm` |
| Use a hosted provider | `--provider openrouter -m <model>` (reads `OPENROUTER_API_KEY`) |
| Use any endpoint | `--base-url http://gpu-box:8000/v1 -m <model>` |
| Make thinking models faster | `--reasoning low` |
| Hide the browser window | `--headless` |
| Use fewer tools for small models | `--tools core` (15 essential tools instead of 25) |
| Send screenshots to a vision model | `--vision` |
| Use a running HTTP server | `--mcp-url http://localhost:8931/mcp` |
| Interactive chat, same browser across tasks | run with no task |

The model needs tool (function) calling. `ollama show <model>` lists `tools` under Capabilities when it has it.
After each action the bridge pastes the page snapshot into the conversation, so small models need fewer steps.

**Clients that connect by URL:**

```bash
./start-mcp-http.sh            # streamable HTTP at http://localhost:8931/mcp, SSE at /sse
```

It listens on localhost only. Add `--headless` or `--isolated` as needed.

**Shell / CLI** (any agent that can run commands):

```bash
playwright-cli open https://example.com --headed
playwright-cli snapshot          # page as YAML with element refs (e1, e2, …)
playwright-cli click e12
playwright-cli fill e5 "hello" --submit
playwright-cli screenshot
playwright-cli close
```

## Useful flags for the MCP server

Add any of these to the `args` list in a client's config:

| Flag | Effect |
|---|---|
| `--headless` | No window. Good for background agents. |
| `--isolated` | Fresh in-memory profile each time, so no saved logins. Use it when several agents run at once, because two agents can't share one saved profile. |
| `--caps vision` | Adds click-by-coordinates tools for screenshot-driven models. |
| `--device "iPhone 15"` / `--mobile` | Mobile emulation. |
| `--extension` | Drive your real Chrome tabs and logins. Needs Google Chrome and the Playwright MCP Bridge extension. |
| `--allowed-origins "https://a.com;https://b.com"` | Keep the agent on certain sites. This is a guardrail, not a security boundary. |

By default, logins persist in a separate Chromium profile for each project. Sign in once in the window
that opens, and agents reuse that profile next time.

## Good to know

- **Browsers only.** Playwright drives web pages (and Electron apps), not native Mac apps. For the
  whole desktop, use Claude's computer use in Claude Desktop, or Codex's computer-use plugin.
- **Web pages can try to instruct the agent** (prompt injection). The agent acts with whatever logins
  its profile has. Keep the HTTP server on localhost, and use `--isolated` for untrusted sites.
- **Claude Code and Codex write snapshots and screenshots to `.playwright-mcp/`** in the project.
  Add that folder to `.gitignore`.
- **Some sites rate-limit or block headless browsers.** Wikipedia returned HTTP 429 during testing.
  If a site refuses, run with a visible window (drop `--headless`).

## Updating

```bash
npm install -g playwright@latest @playwright/mcp@latest @playwright/cli@latest
playwright-cli install-browser chromium
node "$(npm root -g)/@playwright/mcp/node_modules/playwright-core/cli.js" install chromium
playwright install chromium
playwright-cli install --skills claude --global && playwright-cli install --skills agents --global
```

## What was changed on this Mac, and how to undo it

Backups of every config file from before the change are in `~/.playwright/backups/`.

| Changed | Undo |
|---|---|
| Global npm packages listed above | `npm uninstall -g playwright @playwright/mcp @playwright/cli` |
| `playwright` added under `mcpServers` in Claude Desktop's config (by the helper, when the app quits) | Quit Claude, delete that entry, then reopen. To cancel the helper before it runs: `pkill -f add-to-claude-desktop.mjs` |
| `playwright` added to Claude Code (user scope) | `claude mcp remove playwright -s user`, or delete it from `mcpServers` in `~/.claude.json` |
| `[mcp_servers.playwright]` added to `~/.codex/config.toml` | `codex mcp remove playwright` |
| `mcp.servers.playwright` added to `~/.config/opencode/opencode.jsonc` | Delete that block |
| Skills in `~/.claude/skills/playwright-cli` and `~/.agents/skills/playwright-cli` | Delete those folders |
| `~/.playwright/cli.config.json` (sets Chromium as the CLI's default) | Delete the file |
