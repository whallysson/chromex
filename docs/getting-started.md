# Getting Started

## Installation

### Option 1: Global CLI and MCP package

```bash
npm install -g chromex-mcp
chromex --version
command -v chromex
```

Bun can also install the published package globally:

```bash
bun add -g chromex-mcp
```

The package installs `chromex`, its `chromex-cli` alias, and the `chromex-mcp` stdio server.

### Option 2: Claude Code Plugin

Run these commands inside Claude Code:

```text
/plugin marketplace add github:whallysson/chromex
/plugin install chromex
```

The plugin teaches Claude Code when and how to use Chromex. The globally installed CLI remains useful for direct terminal calls and other AI agents.

### Option 3: Current source checkout

```bash
git clone https://github.com/whallysson/chromex.git
cd chromex
bun install
node bin/chromex.mjs --version
```

Cloning or updating the repository does not replace an existing global installation. Use `node bin/chromex.mjs` to test the checkout directly. To deliberately make the checkout global, run:

```bash
npm install -g .
command -v chromex
chromex --version
```

### Optional MCP setup

For Claude Code user scope:

```bash
claude mcp add chromex --scope user -- npx -y chromex-mcp@latest
```

For clients that accept a standard stdio configuration:

```json
{
  "mcpServers": {
    "chromex": {
      "command": "chromex-mcp",
      "args": []
    }
  }
}
```

## Connecting to Your Browser

There are two ways to connect chromex to your browser:

### Method A: Launch a new browser (recommended for first-time users)

This launches a browser with remote debugging pre-enabled. No permission modals, no extra steps.

```bash
# Launch with default browser (auto-detects Chrome, Brave, Edge, Chromium, Vivaldi)
chromex launch

# Launch a specific browser
chromex launch --browser brave

# Launch in incognito mode
chromex launch --incognito

# Launch with a specific URL
chromex launch --url https://example.com

# Launch with a named profile (isolated from your main browser)
chromex launch --profile testing

# Launch through one shared Chrome pipe without approval prompts
chromex launch --pipe --url https://example.com

# Enable trusted extension lifecycle APIs through pipe mode
chromex launch --extension-tools --url about:blank

# Enable WebMCP in a visible supported Chrome build
chromex launch --webmcp --url https://example.com

# Combine flags
chromex launch --browser chrome --incognito --url https://example.com

# Launch a Chromium executable from a non-standard path
chromex launch --browser-path /path/to/chrome --url https://example.com
```

Chrome for Testing is supported as a manual browser option: download it from Google's official Chrome for Testing channel and pass its executable with `--browser-path` or `CHROMEX_BROWSER_PATH`. Chromex does not download or bundle browsers.

### Method B: Connect to an already-running browser

1. Open your browser
2. Navigate to `chrome://inspect/#remote-debugging`
3. Toggle the switch to enable remote debugging
4. Run `chromex list` to verify the connection

> **Note:** With Method B on Chrome 144 or newer, a new DevTools connection can show an "Allow debugging" modal even if an earlier connection was approved. Per-tab daemons and the persistent MCP client reduce reconnects, but Chrome does not persist this permission. Use `chromex launch --pipe` with a Chromex-managed profile for modal-free repeated AI sessions.

If browser discovery fails, run:

```bash
chromex doctor
```

## Your First Commands

```bash
# 1. List all open tabs
chromex list

# Output:
# 6BE827FA  GitHub - Dashboard            https://github.com
# A3F1C920  Google Search                  https://www.google.com
# 8D4E5B12  Stack Overflow - Questions     https://stackoverflow.com

# 2. Take a screenshot of a tab (use the prefix from list)
chromex shot 6BE8

# 3. Get the page title
chromex eval 6BE8 "document.title"

# 4. Get the accessibility tree (compact, great for AI agents)
chromex snap 6BE8
```

## Understanding Target Prefixes

Every command that interacts with a tab requires a `<target>` argument. This is a **unique prefix** of the tab's targetId, shown by the `list` command.

```bash
chromex list
# 6BE827FA  GitHub - Dashboard    https://github.com
# 6BE9A1C3  GitHub - Issues       https://github.com/issues
```

In this example:
- `6BE8` is enough to uniquely identify the Dashboard tab
- `6BE9` is enough for the Issues tab
- `6BE` would be **ambiguous** (matches both) and will be rejected

The CLI always tells you if a prefix is ambiguous — just use more characters.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `CDP_PORT_FILE` | Override the DevToolsActivePort file path. Useful for custom browser profiles or non-standard setups. |
| `CHROMEX_BROWSER_PATH` | Default executable path used by `chromex launch` when your browser is not in a standard location. |
| `CHROMEX_CDP_URL` | HTTP(S), WS(S), or local Unix endpoint override. |
| `CHROMEX_CDP_ENDPOINT` | Named endpoint from `cdpEndpoints` in `~/.chromex/config.json`. |
| `CHROMEX_CDP_HEADERS_FILE` | JSON headers for authenticated HTTP endpoint discovery. |
| `CHROMEX_SESSION` | Default named session, equivalent to `-s <name>`. |
| `CHROMEX_TOOLSET` | MCP discovery set: `full`, `core`, or `devtools`. |
| `CHROMEX_ARTIFACT_ROOT` | Override the default `~/.chromex/artifacts/<workspace>/` root. |
| `CHROMEX_NO_OPEN` | Prevent dashboards and local replay artifacts from opening automatically. |

```bash
# Connect to a browser launched with a custom profile
export CDP_PORT_FILE=~/.chromex/profiles/myprofile/DevToolsActivePort
chromex list
```

## Next Steps

- [Inspect & Debug](./inspect.md) — screenshots, accessibility tree, refs, Browser Issues, CSS/listener inspection, diagnostics, performance, console
- [Navigate & Interact](./navigate.md) — navigation, clicking, typing, scrolling, drag & drop, touch, dialogs
- [Form Filling](./forms.md) — fill, clear, select, check, upload, batch fill with examples
- [Data Access](./data.md) — cookies, localStorage, sessionStorage, Application state, Cache Storage, IndexedDB, Service Workers, PDF export
- [Network Control](./network.md) — request history and bodies, filters, redaction, throttling, interception, mocking, HAR
- [Device Emulation](./emulation.md) — responsive testing, geolocation, timezone, CPU throttling
- [Security](./security.md) — domain filtering, CDP blocklist, audit log, best practices
- [Advanced](./advanced.md) — CPU and heap profiles, trace insights, heap graph analysis, screencasts, extensions, page tools, WebMCP, WebAuthn
- [Architecture](./architecture.md) — how it works: daemon model, connection modes, file layout
- [Troubleshooting](./troubleshooting.md) — version drift, CDP connection failures, debugging prompts, Node warnings, extensions, WebMCP
