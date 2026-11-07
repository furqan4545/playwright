#!/bin/sh
# Serve Playwright MCP over HTTP so any MCP client can connect by URL instead of launching it:
# open-source chat UIs (Open WebUI, LibreChat, Jan...), agent frameworks (LangChain, LlamaIndex,
# pydantic-ai, OpenAI Agents SDK, smolagents...) and this folder's browser-agent.mjs --mcp-url.
#
#   ./start-mcp-http.sh                 -> http://localhost:8931/mcp  (streamable HTTP)
#                                          http://localhost:8931/sse  (legacy SSE clients)
#   PORT=9000 ./start-mcp-http.sh --headless --isolated
#
# Extra arguments go straight to Playwright MCP (run `playwright-mcp --help` for the list).
# It listens on localhost only. Don't pass --host 0.0.0.0 unless you trust your network:
# anyone who can reach the port can drive this browser.

PORT="${PORT:-8931}"
NODE="$(command -v node || echo /opt/homebrew/bin/node)"
CLI="${PLAYWRIGHT_MCP_CLI:-$(npm root -g 2>/dev/null)/@playwright/mcp/cli.js}"
# Screenshots and page snapshots go here instead of into whatever folder you start this from.
OUTPUT_DIR="${OUTPUT_DIR:-${TMPDIR:-/tmp}/playwright-mcp-http}"

if [ ! -f "$CLI" ]; then
  echo "Playwright MCP not found at $CLI. Install it with: npm install -g @playwright/mcp@latest" >&2
  exit 1
fi

echo "Playwright MCP: http://localhost:$PORT/mcp (Ctrl-C to stop)"
exec "$NODE" "$CLI" --browser chromium --port "$PORT" \
  --output-dir "$OUTPUT_DIR" --file-paths absolute "$@"
