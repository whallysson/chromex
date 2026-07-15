# Chromex

[![npm version](https://img.shields.io/npm/v/chromex-mcp.svg)](https://www.npmjs.com/package/chromex-mcp)
[![Node.js 22+](https://img.shields.io/badge/node-%3E%3D22.0.0-brightgreen.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Chromex is an agent-first browser automation and DevTools toolkit that connects directly to Chrome, Brave, Edge, Chromium, and Vivaldi through CDP. It exposes the complete capability set through a token-efficient CLI and 85 typed MCP tools, with zero runtime dependencies.

Use Chromex when an agent needs to automate a real logged-in browser, inspect page and Application state, debug console/network failures, profile performance or memory, test extensions and WebMCP, or collect reproducible evidence without pulling in a heavy browser automation runtime.

## Quick Start

```bash
npm install -g chromex-mcp
chromex --version
chromex launch --pipe --url https://example.com
chromex list
chromex snap <target> --refs
```

`launch --pipe` is the recommended path for repeatable AI sessions: it starts an isolated Chromex profile and avoids Chrome's recurring debugging approval prompt. Use the normal WebSocket mode only when access to an already-running personal browser is intentional.

## Why Chromex

- **CLI-first for lower token usage**: terminal commands return compact plain text and avoid MCP tool-schema overhead.
- **Optional MCP server**: 85 typed tools in the full set, plus focused `core` and `devtools` toolsets for sessions where schema cost matters.
- **No runtime dependencies**: Node.js 22+ built-ins only, including native WebSocket support.
- **Agent-friendly page model**: accessibility snapshots, `@eN` refs, incremental diffs, query filters, auto-snapshots, and contextual hints.
- **Persistent per-tab daemons**: one CDP session per tab, held open through an authenticated Unix socket.
- **Security controls**: domain allow/block lists, CDP method blocklist, socket auth, command timeouts, and audit logs.
- **Local by default**: no hosted service, no telemetry client, no bundled browser download, and session stats stay on your machine.

## What You Can Do Today

- Inspect and automate real logged-in browser sessions, not only fresh headless test contexts.
- Use `--raw` and `--json` for stable pipes, CI, MCP wrappers, and agent-to-agent integrations.
- Create named sessions with isolated browser contexts, reusable targets, and local session dashboards.
- Read page state through compact accessibility snapshots, filtered snapshots, DOM snapshots, HTML, screenshots, and highlighted elements.
- Act on UI through refs, CSS selectors, coordinates, keyboard input, forms, uploads, drag and drop, touch gestures, dialogs, and load-more loops.
- Debug production behavior with console history, network request details, response bodies, HAR export, request blocking, API mocking, throttling, and offline mode.
- Test browser conditions with device presets, viewport resizing, DPR, geolocation, timezone, locale, CPU throttling, incognito contexts, proxies, and custom Chrome flags.
- Diagnose performance and quality with Core Web Vitals, transfer size, DOM/memory counters, Lighthouse audits, JS/CSS coverage, Chrome traces, and heap snapshots.
- Inspect Browser Issues, computed and matched CSS, event listeners, box models, prioritized runtime diagnoses, CPU profiles, heap retaining paths, duplicate strings, and trace insights.
- Capture bounded screencasts with a local replay, manage extensions in trusted pipe mode, and discover or execute WebMCP and page-exposed developer tools.
- Build evidence packs with screenshots, snapshots, HTML, console, network timeline, action timeline, and replay HTML.
- Validate modern browser flows such as passkey/WebAuthn registration and login, downloads, cookies, portable storage state, PDF export, and isolated profiles.
- Inspect Application panel state from the terminal: origin quota, storage usage breakdown, Cache Storage entries/bodies, IndexedDB schemas/rows, and Service Worker registrations.
- Turn `@eN` refs into locators and optional `chromex-test` action code.

The CLI and the default MCP `full` toolset expose the same capability families. CLI commands group related operations into subcommands, while MCP presents 85 individually typed tools.

| Capability | CLI | MCP `full` |
|------------|-----|------------|
| Input, navigation, forms, uploads, dialogs, and emulation | Yes | Yes |
| Console, network, Application state, interception, HAR, and audits | Yes | Yes |
| Browser Issues, CSS/listener/box inspection, and runtime diagnosis | Yes | Yes |
| Web Vitals, CPU profiles, heap sampling, traces, and heap analysis | Yes | Yes |
| Screencasts, extensions, page developer tools, and WebMCP | Yes | Yes |

## Positioning

Chromex is a direct CDP layer for coding agents. It sits between raw Chrome DevTools Protocol and heavier browser automation frameworks.

| Alternative | Trade-off | Chromex angle |
|-------------|-----------|---------------|
| Raw CDP WebSocket | Maximum browser power, but too verbose for agents. | Compact commands, refs, snapshots, and safety defaults. |
| Heavy browser automation libraries | Excellent automation frameworks, but they add dependencies and framework-level abstractions. | Zero-runtime-dependency CLI/MCP that talks to your existing Chromium browser. |
| Browser MCP only | Easy tool discovery, but tool schemas and structured responses add token cost. | CLI-first for cheap agent loops, MCP when typed tools are worth the overhead. |
| Manual DevTools | Great for humans, not scriptable enough for agents. | DevTools-grade inspection exposed as terminal and MCP commands. |

## Requirements

- Node.js 22 or newer.
- macOS or Linux.
- A Chromium-based browser: Chrome, Brave, Edge, Chromium, Chrome Canary, or Vivaldi.

## Zero-Dependency Boundary

The core runtime uses only Node.js built-in modules. Chromex does not install heavy browser automation runtimes, Selenium, browser drivers, telemetry SDKs, update checkers, or bundled browsers.

The only exception is the optional `audit` command: it shells out to Lighthouse with `npx --yes lighthouse` when you explicitly run an audit. All other CLI and MCP commands run through Chromex's own CDP client.

Development dependencies are used only for tests and token benchmarks.

## Browser Setup

Chromex needs Chrome DevTools Protocol access to your browser. Choose one of the two connection modes below before using the CLI or MCP server.

### Option A: Launch a Browser with Chromex

This is the recommended first-time setup. Chromex starts a new browser process with remote debugging already enabled, so there is no manual browser configuration and no "Allow debugging" prompt.

```bash
chromex launch --url https://example.com
```

Useful launch variants:

```bash
chromex launch --browser brave --url https://example.com
chromex launch --profile testing --url https://example.com
chromex launch --incognito --browser chrome
chromex launch --headless --url https://example.com
chromex launch --pipe --url https://example.com
chromex launch --extension-tools --url about:blank
chromex launch --webmcp --url https://example.com
chromex launch --browser-path "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary"
```

Named profiles are stored under `~/.chromex/profiles/` and keep test sessions isolated from your daily browser profile.

`chromex launch --pipe` is the preferred mode for repeated AI sessions. It uses one permission-protected local Unix-socket broker over Chrome's remote-debugging pipe, avoids approval modals, and lets CLI and MCP clients share the same browser connection. `--extension-tools` implies pipe mode because Chrome restricts extension lifecycle APIs to trusted debugging sessions. WebMCP requires a visible supported Chrome build, so do not combine `--webmcp` with `--headless` when the page tools must execute.

Chrome for Testing also works well with Chromex. Download it manually from Google's official Chrome for Testing channel, then point Chromex at the executable with `--browser-path` or `CHROMEX_BROWSER_PATH`. Chromex does not download or bundle a browser.

### Option B: Connect to an Already-Running Browser

Use this when you want Chromex to inspect tabs that are already open in your normal browser.

1. Open Chrome, Brave, Edge, Chromium, or Vivaldi.
2. Go to `chrome://inspect/#remote-debugging`.
3. Enable the remote debugging switch.
4. Run `chromex list` to verify that tabs are visible.

```bash
chromex list
```

Important notes:

- Without remote debugging enabled, Chromex cannot discover or control your open tabs.
- The browser setting is usually persistent across restarts.
- Chrome may show an "Allow debugging" prompt for each new DevTools WebSocket connection to a normal browser profile. This is browser security behavior, so reconnecting from a new CLI or agent process can show it again.
- Per-tab daemons and the persistent MCP connection reduce reconnections, but they do not bypass Chrome's protection for a personal browser profile.
- Use `chromex launch --pipe` with a Chromex-managed isolated profile when a modal-free persistent AI connection is required.

If your browser uses a custom profile or a non-standard `DevToolsActivePort` location, set:

```bash
export CDP_PORT_FILE=/path/to/DevToolsActivePort
```

If your Chromium executable is installed in a non-standard location, either pass `--browser-path` to `chromex launch` or set:

```bash
export CHROMEX_BROWSER_PATH=/path/to/chrome
```

Run the local diagnostic command whenever browser discovery or CDP connection fails:

```bash
chromex doctor
```

## Install the CLI

Install the package globally to get the `chromex` command.

```bash
# npm
npm install -g chromex-mcp

# Bun
bun add -g chromex-mcp
```

Verify which installation every terminal and agent session will use:

```bash
command -v chromex
chromex --version
```

Cloning the repository does not replace an existing global installation. To test the current checkout directly, run `node bin/chromex.mjs`. To deliberately install the current checkout globally, run `npm install -g .` from the repository root and verify the path and version again.

The package installs three binaries:

| Binary | Purpose |
|--------|---------|
| `chromex` | Main CLI for terminal, scripts, CI, and token-sensitive agent sessions. |
| `chromex-cli` | Alias for `chromex`. |
| `chromex-mcp` | MCP server over stdio JSON-RPC. Usually launched by an MCP client. |

## CLI Quick Start

The CLI is the recommended interface when token budget matters. It has no MCP schema overhead, works well in scripts, and returns compact plain-text output designed for LLM agents.

```bash
# 1. Launch or connect to a browser.
chromex launch --url https://github.com/login

# 2. List tabs and copy a target prefix.
chromex list
# 6BE827FA  Sign in to GitHub  https://github.com/login

# 3. Read the page through the accessibility tree and assign refs.
chromex snap 6BE8 --refs
# @e1 [textbox] Username or email address
# @e2 [textbox] Password
# @e3 [button] Sign in

# 4. Interact by ref instead of fragile CSS selectors.
chromex fill 6BE8 @e1 "user@example.com"
chromex fill 6BE8 @e2 "secret"
chromex click 6BE8 @e3

# 5. Inspect browser state.
chromex console 6BE8 list
chromex net 6BE8
chromex shot 6BE8
chromex app 6BE8
```

`<target>` is a unique prefix of the tab target ID returned by `chromex list`. If a prefix is ambiguous, Chromex rejects it and asks for more characters.

For repeatable agent workflows, use named sessions instead of carrying target IDs manually:

```bash
chromex -s auth open https://github.com/login
chromex -s auth snap --refs
chromex -s auth fill @e1 "user@example.com"
chromex -s auth state save ~/.chromex/storage/auth.json
chromex sessions
```

## Token-Efficient Agent Workflow

Chromex is optimized for agents that need to act on browser state without wasting context.

1. Start with `chromex list`.
2. Prefer `chromex snap <target> --refs` over raw HTML.
3. Use `@eN` refs for `click`, `fill`, `hover`, and element screenshots.
4. On large pages, use `--query` before reading a full snapshot.
5. Let auto-snapshot show post-action state after interactive commands.
6. Add `--no-snap` only for fast scripted batches where you do not need immediate page state.
7. Add `--no-hints` when another program parses output strictly.
8. Use `--raw` for pipes and `--json` when another tool needs the stable envelope.
9. Save large snapshots with `--filename` when they are better as artifacts than inline text.

Examples:

```bash
chromex snap 6BE8 --query=login --refs
chromex click 6BE8 @e4
chromex wait 6BE8 networkidle
chromex snap 6BE8 --query=error
chromex --raw eval 6BE8 "document.title"
chromex list --json
chromex snap 6BE8 --filename=~/.chromex/snapshots/login.yml --boxes
chromex locator 6BE8 @e4 --format=chromex-test
chromex click 6BE8 @e4 --code=chromex-test
```

## MCP Server

Use MCP when you want Claude Code or another MCP client to discover typed browser tools directly. MCP is convenient, but it costs more tokens than CLI usage because tool schemas, JSON-RPC framing, and structured tool results add overhead.

### Add to Claude Code

Global, available in all projects:

```bash
# npm
claude mcp add chromex --scope user -- npx -y chromex-mcp@latest

# Bun
claude mcp add chromex --scope user -- bunx chromex-mcp@latest
```

Project-only:

```bash
# npm
claude mcp add chromex -- npx -y chromex-mcp@latest

# Bun
claude mcp add chromex -- bunx chromex-mcp@latest
```

For MCP clients that accept a standard stdio configuration, point the client at the installed binary:

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

After setup, the MCP client can call tools such as `chromex_list`, `chromex_snapshot`, `chromex_click`, `chromex_fill`, `chromex_network`, `chromex_issues`, `chromex_inspect`, `chromex_diagnose`, `chromex_perf`, `chromex_trace`, `chromex_heap`, `chromex_screencast`, `chromex_extensions`, `chromex_third_party`, `chromex_webmcp`, `chromex_app_summary`, `chromex_cache_entries`, `chromex_indexeddb_rows`, and `chromex_evidence`.

Tools that produce machine-readable data or artifacts also include MCP `structuredContent`, so agents can read paths and metadata without parsing the human text block.

The default `full` toolset exposes all 85 tools. Use a focused toolset when the MCP client sends every schema into the model context:

```bash
chromex-mcp --toolset=core
chromex-mcp --toolset=devtools
CHROMEX_TOOLSET=full chromex-mcp
```

`core` exposes 24 navigation, inspection, input, form, and emulation tools. `devtools` exposes 26 browser-diagnostics, performance, trace, heap, Application, and audit tools. This selection changes discovery only; the complete CLI and the default MCP toolset retain every capability.

### Claude Code Auto-Approve

To approve all Chromex MCP tools at once, add this to `~/.claude/settings.json`:

```json
{
  "permissions": {
    "allow": ["mcp__chromex"]
  }
}
```

For CLI usage inside Claude Code, approve the shell command instead:

```json
{
  "permissions": {
    "allow": [
      "Bash(chromex *)",
      "Bash(chromex-cli *)"
    ]
  }
}
```

Review these permissions before enabling them. Chromex security settings still apply, and every command is audit-logged when `auditLog` is enabled.

## CLI vs MCP

Both interfaces use the same CDP core and the same per-tab daemons. Choose based on the workflow.

| Use case | Prefer CLI | Prefer MCP |
|----------|------------|------------|
| Token-sensitive agent sessions | Yes | No |
| Terminal scripts and CI | Yes | No |
| Quick one-off browser inspection | Yes | Optional |
| Typed tool discovery in Claude Code | No | Yes |
| Inline screenshots returned to the client | No, screenshots are files | Yes |
| Granular per-tool permissions | Shell pattern only | Yes |
| Lowest setup friction for MCP users | Optional | Yes |

You can remove MCP at any time and keep using the CLI:

```bash
claude mcp remove chromex
```

## Command Overview

### Pages and Browser

```bash
chromex list
chromex list --include-sensitive
chromex open "https://example.com"
chromex -s auth open "https://example.com/login"
chromex -s auth snap --refs
chromex sessions
chromex show --annotate
chromex close <target>
chromex focus <target>
chromex launch --url https://example.com
chromex launch --browser brave --incognito
chromex launch --headless --url https://example.com
chromex launch --pipe --url https://example.com
chromex launch --extension-tools --url about:blank
chromex launch --webmcp --url https://example.com
chromex launch --browser-path /path/to/chrome --url https://example.com
chromex doctor
chromex incognito https://example.com
chromex stop
```

### Inspect

```bash
chromex snap <target> --refs
chromex snap <target> --query=login
chromex snap <target> --filename=~/.chromex/snapshots/login.yml --boxes
chromex html <target> "#main"
chromex shot <target>
chromex shot <target> ~/.chromex/screenshots/full.png --full
chromex shot <target> @e5
chromex console <target> list
chromex net <target>
chromex net <target> <requestId> --include-sensitive
chromex net <target> <requestId> --body-limit=100000
chromex perf <target>
chromex domsnapshot <target> --styles
chromex issues <target> enable
chromex issues <target> list
chromex inspect <target> all "#checkout"
chromex diagnose <target>
chromex evidence <target> start checkout-flow
chromex evidence <target> mark "after login"
chromex evidence <target> stop
chromex evidence <target> replay
```

### Navigate and Wait

```bash
chromex nav <target> "https://example.com"
chromex nav <target> back
chromex nav <target> reload-hard
chromex waitfor <target> ".results" 10000
chromex wait <target> networkidle
chromex scroll <target> bottom
```

### Interact

```bash
chromex click <target> @e5
chromex clickxy <target> 100 200
chromex key <target> Enter
chromex type <target> "hello world"
chromex hover <target> @e12
chromex locator <target> @e12 --format=chromex-test
chromex click <target> @e12 --code=chromex-test
chromex drag <target> "#source" "#dest"
chromex dialog <target> accept
```

### Forms

```bash
chromex fill <target> @e1 "user@example.com"
chromex clear <target> "#search"
chromex select <target> "#country" "BR"
chromex check <target> "#terms" true
chromex upload <target> "#avatar" /tmp/photo.png
chromex form <target> '{"#name":"John","#email":"john@example.com","#terms":true}'
```

### Data

```bash
chromex cookies <target>
chromex cookies <target> set '{"name":"token","value":"abc"}'
chromex storage <target> local
chromex storage <target> session
chromex storage <target> usage
chromex state <target> save ~/.chromex/storage/auth.json
chromex state <target> load ~/.chromex/storage/auth.json
chromex app <target> summary
chromex sw <target>
chromex cache <target> list
chromex cache <target> entries <cacheId> --query=/api
chromex idb <target> list
chromex idb <target> schema <databaseName>
chromex idb <target> rows <databaseName> <objectStoreName> --limit=20
chromex pdf <target>
```

### Network, Emulation, and Diagnostics

```bash
chromex throttle <target> 3g
chromex intercept <target> block "*.analytics.*"
chromex intercept <target> mock "/api/user" --status=200 --content-type=application/json --body='{"ok":true}'
chromex intercept <target> mock "/api/slow" --delay=750 --status=503 --body='unavailable'
chromex intercept <target> block "*.tracker.*" --abort=blockedbyclient
chromex intercept <target> on --remove-header=authorization
chromex har <target> start
chromex har <target> stop ~/.chromex/har/trace.har
chromex emulate <target> iphone-15-pro
chromex resize <target> 1280 720
chromex geo <target> -23.55 -46.63
chromex timezone <target> "America/Sao_Paulo"
chromex cpu <target> 4
chromex audit <target> performance,accessibility desktop
chromex stats <target> --full
```

### Advanced

```bash
chromex eval <target> "document.title"
chromex evalraw <target> "Page.getLayoutMetrics"
chromex inject <target> "window.DEBUG=true"
chromex download <target> allow ~/.chromex/downloads
chromex coverage <target> start
chromex trace <target> start
chromex trace <target> insights
chromex heap <target> snapshot ~/.chromex/heap/heap.heapsnapshot
chromex heap <target> summary
chromex screencast <target> start --max-frames=120
chromex extensions <target> list
chromex third-party <target> list
chromex webmcp <target> list
chromex webauthn <target> enable
```

Run `chromex --help` for the full command reference.

## Agent-Focused Features

### Ref-Based Selection

`chromex snap --refs` assigns stable refs to interactive elements:

```bash
chromex snap <target> --refs
# @e1 [textbox] Email
# @e2 [textbox] Password
# @e3 [button] Sign in

chromex fill <target> @e1 "user@example.com"
chromex click <target> @e3
```

Refs are shorter and more robust than CSS selectors for most agent workflows.

### Incremental Snapshots

The first snapshot returns the page tree. Later snapshots return only changed nodes unless you pass `--full`.

```bash
chromex snap <target> --refs
chromex click <target> @e3
# The click response includes a fresh incremental snapshot with refs.
```

### Query-Filtered Snapshots

Use `--query` to keep output small on large pages:

```bash
chromex snap <target> --query=issues --refs
chromex snap <target> --query="sign in" --refs
```

Chromex preserves ancestor nodes so the filtered output still has usable context.

### Contextual Hints

After actions that refresh refs, Chromex can append a `help[N]:` block with likely next commands:

```text
help[3]:
  chromex fill <t> @e1 "<value>"  # textbox "Email"
  chromex click <t> @e3           # button "Sign in"
  chromex click <t> @e4           # link "Forgot password?"
```

Disable hints with `--no-hints`.

### Stable Output and Artifacts

Chromex keeps plain text as the default output, but also supports stable modes for scripts:

```bash
chromex --raw eval <target> "document.title"
chromex list --json
chromex snap <target> --filename=~/.chromex/snapshots/home.yml --boxes
```

`--raw` prints only the primary command output and suppresses hints and auto-snapshot noise. `--json` returns a stable envelope with `ok`, `command`, `target`, `text`, `data`, `artifacts`, and `error`.

Generated artifacts are written under `~/.chromex/artifacts/<workspace>/` by default. Paths in the Chromex namespace, such as `.chromex/storage/auth.json` or `~/.chromex/storage/auth.json`, resolve to `~/.chromex/...`. Other explicit absolute or relative file paths are respected as provided. Set `CHROMEX_ARTIFACT_ROOT` to override the default artifact root for CI or tests.

### Named Sessions

Named sessions let agents reuse isolated browser contexts without carrying target IDs:

```bash
chromex -s auth open https://example.com/login
chromex -s auth snap --refs
chromex -s auth click @e3
chromex sessions
chromex show --annotate
chromex close-all
chromex delete-data auth
```

`CHROMEX_SESSION=auth` can replace `-s auth` for shell scripts.
`chromex show` opens the generated dashboard in the default browser during normal CLI usage; set `CHROMEX_NO_OPEN=1` or use `--json`/`--raw` to only write the artifact.

Named sessions keep a private storage-state file under `~/.chromex/session-data/<name>/storage-state.json`. Chromex restores it when the named session is reopened and refreshes it after state-changing session commands.

`chromex show --annotate` generates a local dashboard with screenshot previews, region/point marking, per-mark notes, and JSON export. Browsers with File System Access support can save the exported pack directly; other browsers download the JSON file.

### Storage State and Locators

Storage state captures cookies plus localStorage for the current origin:

```bash
chromex state <target> save ~/.chromex/storage/auth.json
chromex state <target> load ~/.chromex/storage/auth.json
```

Refs can also be converted into reusable locator output or starter action code:

```bash
chromex locator <target> @e5 --format=chromex-test
chromex locator <target> @e5 --format=css
chromex locator <target> @e5 --format=testing-library
chromex fill <target> @e1 "user@example.com" --code=chromex-test
```

### Evidence Packs

Evidence packs collect browser evidence without recording video:

```bash
chromex evidence <target> start checkout-flow
chromex click <target> @e3
chromex fill <target> @e5 "user@example.com"
chromex evidence <target> mark "after login"
chromex evidence <target> stop
chromex evidence <target> replay
```

Each pack is written under `~/.chromex/artifacts/<workspace>/evidence/` and includes screenshots, accessibility snapshots with boxes, HTML captures, console JSON, network JSON, action timeline, `evidence.json`, and `index.html` for local replay. Values passed to `fill`, `type`, and `form` are redacted from the action timeline.

## Application State Suite

Chromex exposes browser Application panel state without heavy browser automation runtimes or extra packages. This is useful for debugging PWAs, offline behavior, stale caches, local database migrations, authentication state, and quota issues from the same logged-in browser session an agent is already using.

```bash
# One-line overview for the current origin
chromex app <target> summary

# Origin quota and per-storage-type usage
chromex storage <target> usage

# Service Worker registrations and versions
chromex sw <target>
chromex sw <target> update https://example.com/
chromex sw <target> skip-waiting https://example.com/

# Cache Storage
chromex cache <target> list
chromex cache <target> entries <cacheId> --query=/api
chromex cache <target> body <cacheId> https://example.com/app.js

# IndexedDB
chromex idb <target> list
chromex idb <target> schema app-db
chromex idb <target> rows app-db users --limit=20
```

`chromex app <target> summary` includes origin, quota, localStorage key count, sessionStorage key count, cookie count, Cache Storage cache/entry counts, IndexedDB database count, active/waiting Service Worker counts, storage bucket count, and manifest status.

Destructive Application commands are explicit: `storage clear-site-data`, `sw unregister`, `cache delete-entry`, `cache delete`, and `idb clear`.

## Security

Chromex creates `~/.chromex/config.json` on first run:

```json
{
  "commandTimeout": 15000,
  "navigationTimeout": 30000,
  "idleTimeout": 1200000,
  "allowedDomains": [],
  "blockedDomains": [],
  "blockedCdpMethods": [
    "Network.enable",
    "Network.setRequestInterception",
    "Network.setCacheDisabled",
    "Page.setDocumentContent",
    "Security.disable",
    "Security.setIgnoreCertificateErrors",
    "Fetch.enable",
    "Fetch.fulfillRequest",
    "Fetch.continueRequest",
    "Browser.close",
    "Browser.crashGpuProcess",
    "Target.disposeBrowserContext",
    "SystemInfo.getProcessInfo",
    "Storage.clearDataForOrigin",
    "Storage.getCookies",
    "IndexedDB.requestData"
  ],
  "auditLog": true,
  "socketAuth": true
}
```

Recommended security practices:

- Add sensitive sites to `blockedDomains`, such as email, banking, password managers, and admin panels.
- Use `allowedDomains` in restricted environments where the agent should access only specific hosts.
- Keep `socketAuth` enabled.
- Keep `auditLog` enabled and review `~/.chromex/audit.log` when needed.
- Prefer `chromex launch --profile testing` for isolated browser state.

Page URLs, network, console, extension-storage, third-party, and WebMCP outputs redact secret-shaped headers and fields by default. The browser still sends and receives the original values. Use CLI `--include-sensitive` or MCP `includeSensitive: true` only on the specific live call that needs exact values. Audit logs, page caches, stats, HAR, and structured evidence timelines, network data, and console data remain redacted even when a live response is revealed. Screenshots, screencasts, snapshots, HTML, traces, heap snapshots, and raw page content can still contain sensitive information and should be handled accordingly.

See [docs/security.md](docs/security.md) for the full security model.

## How It Works

```text
CLI or MCP client -> authenticated Unix socket -> per-tab daemon -> CDP WebSocket -> browser
                                                        \-> pipe broker -> Chrome debugging pipe
```

1. Chromex finds a browser DevTools endpoint or a Chromex pipe-broker marker.
2. The first tab command starts a detached daemon for that tab.
3. The daemon attaches once through CDP and keeps the session open.
4. CLI and MCP commands talk to the daemon through an authenticated Unix socket; pipe mode multiplexes CDP through a second local socket restricted to the current OS user.
5. Daemons exit after the configured idle timeout.

See [docs/architecture.md](docs/architecture.md) for implementation details.

## Documentation

| Guide | Description |
|-------|-------------|
| [Getting Started](docs/getting-started.md) | Installation, browser setup, first commands. |
| [Inspect and Debug](docs/inspect.md) | Screenshots, accessibility tree, refs, Browser Issues, CSS/listener inspection, diagnostics, performance, and console. |
| [Navigate and Interact](docs/navigate.md) | Navigation, clicking, typing, scrolling, drag and drop, touch, dialogs. |
| [Form Filling](docs/forms.md) | Fill, clear, select, check, upload, batch form examples. |
| [Data Access](docs/data.md) | Cookies, localStorage, sessionStorage, Application state, Cache Storage, IndexedDB, Service Workers, PDF export. |
| [Network Control](docs/network.md) | Live request history and bodies, filtering, redaction, throttling, interception, mocking, and HAR. |
| [Device Emulation](docs/emulation.md) | Responsive testing, geolocation, timezone, CPU throttling. |
| [Security](docs/security.md) | Domain filtering, CDP blocklist, audit log, best practices. |
| [Advanced](docs/advanced.md) | CPU and heap profiles, trace insights, heap graph analysis, screencasts, extensions, page tools, WebMCP, and WebAuthn. |
| [Architecture](docs/architecture.md) | Daemon model, connection modes, and file layout. |
| [Troubleshooting](docs/troubleshooting.md) | Installation drift, connection failures, debugging prompts, Node warnings, extensions, and WebMCP. |

## Development

```bash
git clone https://github.com/whallysson/chromex.git
cd chromex
bun install
bun run test
```

The runtime package has no dependencies. Development dependencies are used only for tests and token benchmarks.

Run the browser-backed smoke flow explicitly when validating a release candidate:

```bash
bun run test:smoke
```

The smoke script launches a temporary headless Chromium profile through `CDP_PORT_FILE`, exercises named sessions, snapshots, locators, storage state, annotation dashboard artifacts, and then stops the launched process.

To reproduce the token-format comparison:

```bash
bun tests/benchmarks/token-format-comparison.mjs
```

## License

MIT. See [LICENSE](LICENSE).
