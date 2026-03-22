# Chromex

Zero-dependency Chrome DevTools Protocol toolkit for AI agents. 56 typed MCP tools + CLI. Connects directly to Chrome, Brave, Edge, or Chromium via WebSocket. No Puppeteer, no bloat.

## Features

- **56 MCP tools** -- typed JSON Schema, annotations (`readOnlyHint`, `destructiveHint`), inline screenshots (base64)
- **Zero dependencies** -- uses only Node.js 22+ built-in modules (WebSocket, fs, net, crypto)
- **Ref-based selection** -- `snap --refs` assigns `@e1`, `@e2`... to interactive elements, then `click @e5` or `fill @e3 "value"`. No fragile CSS selectors
- **Incremental snapshots** -- second snapshot returns only changed nodes (diff), reducing output from thousands of lines to just what changed
- **Auto-snapshot** -- interactive commands (click, fill, nav, etc.) automatically append an incremental snapshot with refs, so the agent sees the page state in a single round-trip
- **Scroll detection** -- snapshots report scrollable containers with remaining distance (`[scroll: page: down:1200px | sidebar: up:300px]`)
- **Per-tab persistent daemons** -- each tab gets a background process connected via Unix socket. Chrome's "Allow debugging" modal fires once, not on every command
- **Security hardened** -- domain filtering (allow/blocklist), CDP method blocklist, token-authenticated sockets, full audit log
- **Multi-browser** -- auto-detects Brave, Chrome, Chrome Canary, Chromium, Edge, Vivaldi (macOS + Linux)
- **Network control** -- throttle to 3G/offline, intercept & mock requests, record HAR files
- **Form filling** -- fill inputs, select dropdowns, toggle checkboxes, upload files, batch fill entire forms. Works with React/Vue/Angular
- **Browser launcher** -- launch browser with remote debugging pre-enabled (skips the "Allow debugging" modal entirely)
- **CLI included** -- same commands available from the terminal for scripts and CI/CD

## Requirements

- Node.js 22+ (for built-in WebSocket)
- Any Chromium-based browser

## Installation

```bash
# Add to Claude Code (global -- all projects)
claude mcp add chromex -s user npx chromex-mcp@latest

# Or project-only
claude mcp add chromex npx chromex-mcp@latest
```

### Auto-Approve (recommended)

Add to `~/.claude/settings.json`:

```json
{
  "permissions": {
    "allow": ["mcp__chromex"]
  }
}
```

This approves all 56 MCP tools at once. For granular control, approve individual tools:

```json
{
  "permissions": {
    "allow": [
      "mcp__chromex__chromex_list",
      "mcp__chromex__chromex_snapshot",
      "mcp__chromex__chromex_screenshot",
      "mcp__chromex__chromex_perf"
    ]
  }
}
```

### Global install (optional)

```bash
npm install -g chromex-mcp
```

This installs three binaries:

| Binary | Purpose |
|--------|---------|
| `chromex` | CLI -- the main command for terminal usage |
| `chromex-cli` | Alias for `chromex` |
| `chromex-mcp` | MCP server (stdio JSON-RPC) -- used by `claude mcp add`, not run directly |

```bash
chromex list                          # List open tabs
chromex launch --url https://example.com  # Launch browser
chromex snap 6BE8 --refs              # Snapshot with refs
chromex click 6BE8 @e3               # Click by ref
```

## Connect to Your Browser

**Option A: Launch a new browser** (recommended -- no setup needed)

```bash
chromex launch --url https://example.com
```

This starts Chrome/Brave/Edge with remote debugging pre-enabled. No manual configuration required.

**Option B: Connect to an already-running browser**

1. Open your browser (Chrome, Brave, Edge, etc.)
2. Navigate to `chrome://inspect/#remote-debugging`
3. **Toggle the switch ON** to enable remote debugging
4. Run `chromex list` to verify the connection

> **Important:** Without step 3, chromex cannot connect to your browser. This is a one-time setup -- the setting persists across browser restarts.

> **Note:** With Option B, Chrome will show an "Allow debugging" dialog the first time you access each tab. Click "Allow" once per tab -- the daemon keeps the session alive after that.

## Quick Start

```bash
# List open tabs
chromex list
# Output: 6BE827FA  Example Domain  https://example.com

# Take a screenshot
chromex shot 6BE8 /tmp/page.png

# Get the accessibility tree with interactive refs
chromex snap 6BE8 --refs
# Output:
#   @e1 [textbox] Email
#   @e2 [textbox] Password
#   @e3 [button] Sign in

# Fill a form using refs (no CSS selectors needed!)
chromex fill 6BE8 @e1 "user@example.com"
chromex fill 6BE8 @e2 "secret123"
chromex click 6BE8 @e3

# Check Core Web Vitals
chromex perf 6BE8
```

## Commands

`<target>` is a unique prefix of the targetId shown by `list` (e.g. `6BE827FA`).

### Pages & Browser

```bash
chromex list                                       # List open pages
chromex open   "https://example.com"               # Open new tab
chromex close  <target>                            # Close tab
chromex focus  <target>                            # Activate/focus tab
chromex launch                                     # Launch browser with debugging
chromex launch --incognito --browser brave          # Launch Brave in incognito
chromex launch --headless --url https://example.com # Headless mode for CI/CD
chromex launch --proxy socks5://localhost:1080      # Launch with proxy
chromex launch --insecure                           # Ignore certificate errors
chromex launch --chrome-arg --disable-web-security  # Pass custom Chrome flag
chromex launch --profile testing --url https://...  # Isolated profile + URL
chromex incognito https://example.com               # Isolated context (no relaunch)
chromex stop                                        # Stop all daemons
```

### Inspect

```bash
chromex snap    <target>                    # Accessibility tree snapshot (compact)
chromex snap    <target> --refs             # With interactive refs (@e1, @e2...)
chromex snap    <target> --depth=3          # Limit tree depth
chromex snap    <target> --full             # Force full snapshot (skip diff)
chromex html    <target> "#main"            # Element HTML by selector
chromex shot    <target> /tmp/page.png      # Viewport screenshot
chromex shot    <target> /tmp/full.png --full  # Full page screenshot
chromex shot    <target> --format=jpeg --quality=80  # JPEG/WebP with quality control
chromex shot    <target> @e5               # Screenshot of specific element by ref
chromex net     <target>                    # List network requests (CDP tracked)
chromex net     <target> <requestId>        # Request detail: headers, timing, body
chromex perf    <target>                    # Core Web Vitals + memory + DOM stats
chromex console <target> 5000               # Capture console.log/error for 5s
chromex console <target> list               # Show stored messages since daemon start
chromex console <target> detail <id>        # Message detail with stack trace
chromex domsnapshot <target>                # Structured DOM with bounding rects
chromex domsnapshot <target> --styles       # Include computed styles
chromex highlight <target> "h1"             # Highlight element with overlay
chromex highlight <target> clear            # Remove highlight
```

### Evaluate

```bash
chromex eval    <target> "document.title"                          # Run JS
chromex eval    <target> "document.querySelectorAll('a').length"    # Count links
chromex evalraw <target> "DOM.getDocument"                         # Raw CDP command
chromex evalraw <target> "Page.getLayoutMetrics"                   # Layout info
```

### Navigate & Wait

```bash
chromex nav     <target> "https://example.com"    # Navigate + wait for load
chromex nav     <target> back                      # Go back in history
chromex nav     <target> forward                   # Go forward in history
chromex nav     <target> reload                    # Reload page
chromex nav     <target> reload-hard               # Reload ignoring cache
chromex waitfor <target> ".results" 10000          # Wait for CSS selector (10s)
chromex wait    <target> networkidle               # Wait for network idle
chromex wait    <target> load                      # Wait for page load
chromex wait    <target> domready                  # Wait for DOMContentLoaded
chromex wait    <target> fcp                       # Wait for First Contentful Paint
chromex scroll  <target> down 500                  # Scroll down 500px
chromex scroll  <target> up 300                    # Scroll up 300px
chromex scroll  <target> top                       # Scroll to top
chromex scroll  <target> bottom                    # Scroll to bottom
chromex scroll  <target> to "#footer"              # Scroll to element
```

### Interact

```bash
chromex click   <target> "button.submit"           # Click by CSS selector
chromex click   <target> @e5                       # Click by ref (from snap --refs)
chromex click   <target> @e5 --dbl                 # Double-click
chromex clickxy <target> 100 200                   # Click at CSS pixel coords
chromex clickxy <target> 100 200 --dbl             # Double-click at coords
chromex key     <target> Enter                     # Press key
chromex key     <target> "Control+A"               # Key combination
chromex key     <target> "Control+Shift+R"         # Multi-modifier combo
chromex type    <target> "hello world"             # Type text (works cross-origin)
chromex hover   <target> @e12                      # Hover element by ref
chromex drag    <target> "#source" "#dest"         # Drag & drop by selector
chromex drag    <target> 100,200 400,500           # Drag & drop by coordinates
chromex touch   <target> tap 200 300               # Touch tap
chromex touch   <target> swipe 200,400 200,100     # Swipe gesture
chromex touch   <target> pinch 200 300 2.0         # Pinch zoom in
chromex touch   <target> longpress 200 300 1000    # Long press (1s)
chromex dialog  <target> accept                    # Accept alert/confirm
chromex dialog  <target> dismiss                   # Dismiss dialog
chromex dialog  <target> auto                      # Auto-accept all dialogs
chromex loadall <target> ".load-more" 500          # Click until element disappears
```

### Forms

```bash
chromex fill    <target> "#email" "user@test.com"  # Fill input/textarea
chromex fill    <target> @e1 "user@test.com"       # Fill by ref
chromex clear   <target> "#search"                 # Clear field
chromex select  <target> "#country" "BR"           # Select dropdown option
chromex check   <target> "#terms"                  # Check checkbox
chromex check   <target> "#newsletter" false        # Uncheck checkbox
chromex upload  <target> "#avatar" /tmp/photo.png   # Upload file

# Batch fill entire form
chromex form    <target> '{"#name":"John","#email":"john@test.com","#terms":true}'
```

### Data

```bash
chromex cookies <target>                            # List cookies
chromex cookies <target> set '{"name":"x","value":"y"}'  # Set cookie
chromex cookies <target> clear                      # Clear all cookies
chromex storage <target> local                      # Dump localStorage
chromex storage <target> session                    # Dump sessionStorage
chromex storage <target> clear                      # Clear both
chromex pdf     <target> /tmp/page.pdf              # Export as PDF
```

### Network

```bash
chromex throttle <target> 3g                       # Throttle to 3G
chromex throttle <target> slow-3g                  # Throttle to slow 3G
chromex throttle <target> 4g                       # Throttle to 4G
chromex throttle <target> offline                  # Go offline
chromex throttle <target> custom 200 1000 500      # Custom: latency, down, up (kbps)
chromex throttle <target> reset                    # Remove throttling

chromex intercept <target> block "*.analytics.*"   # Block matching requests
chromex intercept <target> mock "/api/user" '{"name":"test"}'  # Mock response
chromex intercept <target> rules                   # List active rules
chromex intercept <target> off                     # Disable interception

chromex har <target> start                         # Start recording
chromex har <target> stop /tmp/trace.har           # Save HAR file
```

### Emulate

```bash
chromex emulate  <target> iphone-14                # 390x844 @3x mobile
chromex emulate  <target> iphone-15-pro            # 393x852 @3x mobile
chromex emulate  <target> ipad-pro                 # 1024x1366 @2x tablet
chromex emulate  <target> pixel-7                  # 412x915 @2.625x mobile
chromex emulate  <target> galaxy-s23               # 360x780 @3x mobile
chromex emulate  <target> macbook-air              # 1440x900 @2x laptop
chromex emulate  <target> desktop-1080p            # 1920x1080 @1x
chromex emulate  <target> desktop-4k               # 3840x2160 @1x
chromex emulate  <target> reset                    # Reset to default
chromex resize   <target> 1280 720                 # Custom viewport dimensions
chromex resize   <target> 1440 900 2               # Custom with DPR (retina)
chromex geo      <target> -23.55 -46.63            # Set geolocation (Sao Paulo)
chromex geo      <target> reset                    # Clear geolocation
chromex timezone <target> "America/Sao_Paulo"      # Set timezone
chromex locale   <target> "pt-BR"                  # Set locale
chromex cpu      <target> 4                        # CPU 4x slower
chromex cpu      <target> reset                    # Reset CPU speed
```

### Advanced

```bash
chromex inject   <target> "window.DEBUG=true"      # Inject JS on every page load
chromex inject   <target> --file /tmp/preload.js   # Inject from file
chromex inject   <target> --list                   # List injected scripts
chromex inject   <target> --remove <id>            # Remove injected script
chromex download <target> allow /tmp/downloads     # Auto-accept downloads
chromex download <target> deny                     # Block downloads
chromex coverage <target> start                    # Start code coverage
chromex coverage <target> stop                     # Coverage report (JS + CSS %)
chromex trace    <target> start                    # Start performance trace
chromex trace    <target> stop /tmp/trace.json     # Save trace (chrome://tracing)
chromex heap     <target> snapshot /tmp/heap.hs    # Heap snapshot (memory analysis)
chromex webauthn <target> enable                   # Virtual authenticator (passkeys)
chromex webauthn <target> creds                    # List stored credentials
chromex webauthn <target> disable                  # Remove authenticator
```

### Audit & Analytics

```bash
chromex audit   <target>                           # Full Lighthouse audit (all categories)
chromex audit   <target> performance,seo           # Specific categories
chromex audit   <target> accessibility desktop     # Accessibility on desktop
chromex stats   <target>                           # Session analytics (command counts, timing)
chromex stats   <target> --full                    # Full action timeline
chromex stats   <target> --reset                   # Reset counters
chromex stats   <target> --export=/tmp/stats.json  # Export as JSON
```

## Ref-Based Selection

The killer feature for AI agents. Instead of fragile CSS selectors, use numbered refs:

```bash
# 1. Get interactive elements with refs
chromex snap <target> --refs
# Output:
#   @e1 [textbox] Username
#   @e2 [textbox] Password
#   @e3 [checkbox] Remember me
#   @e4 [button] Sign in
#   @e5 [link] Forgot password?

# 2. Interact using refs
chromex fill  <target> @e1 "admin"
chromex fill  <target> @e2 "secret123"
chromex click <target> @e3
chromex click <target> @e4
```

Refs are assigned to all interactive elements (buttons, links, inputs, checkboxes, radios, dropdowns, tabs, switches, sliders, search boxes). They persist until the next `snap --refs` call.

Supported ref commands: `click @eN`, `fill @eN "value"`, `hover @eN`.

## Snapshot Optimizations

Chromex snapshots are designed to minimize token usage for AI agents.

### Incremental Diff

The first snapshot returns the full accessibility tree. Subsequent snapshots return only nodes that changed:

```
[incremental: 2 changed, 45 unchanged]
  *[textbox] Email = "user@example.com"
  *[button] Submit
```

- Changed/new nodes are marked with `*`
- Unchanged subtrees are collapsed entirely
- Use `--full` to force a full snapshot (skips diff)
- Navigation (`nav`) resets the diff baseline automatically

### Depth Limiting

Limit tree depth for large pages:

```bash
chromex snap <target> --depth=3    # Only 3 levels deep
```

Nodes at the depth limit render as leaves (children are not expanded).

### Scroll Detection

Snapshots automatically detect scrollable containers and report remaining scroll distance:

```
[scroll: page: down:1200px | sidebar: up:300px, down:800px]
```

### Visibility Filtering

- Ignored/hidden accessibility nodes are automatically omitted
- Disabled interactive elements are shown but not assigned refs (can't be interacted with)
- Generic wrapper nodes (`div`, `span` with no semantic role) are collapsed -- their children inherit the parent's depth
- Names longer than 200 characters are truncated with `...`

## Auto-Snapshot

Interactive commands automatically append an incremental snapshot with refs after execution. This lets the AI agent see the updated page state without a separate `snap` call:

```bash
chromex click <target> @e3
# Output:
#   Clicked @e3 [button] "Submit"
#
#   [incremental: 5 changed, 40 unchanged]
#   @e1 [heading] Thank you!
#   @e2 [link] Back to home
#   ...
```

Commands that trigger auto-snapshot: `click`, `clickxy`, `type`, `key`, `fill`, `clear`, `select`, `check`, `form`, `nav`, `dialog`, `loadall`, `drag`, `touch`, `upload`.

Suppress with `--no-snap` for scripts doing rapid sequential actions:

```bash
chromex fill <target> @e1 "user@test.com" --no-snap
chromex fill <target> @e2 "secret123" --no-snap
chromex click <target> @e3    # Only this one triggers snapshot
```

## MCP vs CLI

Both interfaces call the same core, same daemons, same commands. The difference is how they integrate with Claude Code.

| | CLI (`chromex-cli`) | MCP Server (`chromex-mcp`) |
|---|---|---|
| Token overhead | Zero schema cost | ~500 tokens per tool used (deferred loading) |
| Auto-approve | Glob pattern in settings | `"mcp__chromex"` -- one line |
| Permissions | All-or-nothing | Per-tool granularity |
| Parameters | Positional string args | Typed JSON Schema |
| Screenshots | File path (needs `Read` to view) | Inline image (base64, no extra call) |
| Best for | Terminal, scripts, CI/CD, token-sensitive sessions | Plug-and-play automation, users who want zero-config |

### Switching Between MCP and CLI

You can enable and disable the MCP server at any time. The CLI always works regardless.

**Disable MCP** (saves ~3-5k tokens per session):

```bash
claude mcp remove chromex
```

The CLI (`chromex-cli`) continues working normally -- same commands, same daemons, no change.

**Re-enable MCP:**

```bash
# Global (all projects)
claude mcp add chromex -s user npx chromex-mcp@latest

# Project-only
claude mcp add chromex npx chromex-mcp@latest
```

**When to disable MCP:**
- Token-sensitive sessions where every token counts
- You only need occasional commands (`list`, `snap`, `shot`)
- You're already comfortable with the CLI syntax
- You're using chromex from terminal/scripts, not from Claude Code

**When to keep MCP enabled:**
- Automating multi-step browser workflows (snap -> click -> fill -> snap)
- You want per-tool auto-approve without glob patterns
- You want inline screenshots without a separate `Read` call
- First time using chromex (discovery via tool schema)

### CLI Auto-Approve

If you prefer the CLI interface, add this to `~/.claude/settings.json`:

```json
{
  "permissions": {
    "allow": [
      "Bash(chromex-cli *)"
    ]
  }
}
```

## Security

Config at `~/.chromex/config.json` (auto-created on first run):

```json
{
  "blockedDomains": ["mail.google.com", "bank.example.com"],
  "allowedDomains": [],
  "blockedCdpMethods": ["Browser.close", "Storage.getCookies", "..."],
  "socketAuth": true,
  "auditLog": true
}
```

- **Domain filtering**: block sensitive sites or restrict to a whitelist
- **CDP blocklist**: dangerous methods blocked by default in `evalraw`
- **Socket auth**: 32-byte random token per session (mode 0600)
- **Audit log**: every command logged with timestamp and status

See [docs/security.md](docs/security.md) for full details.

## How It Works

1. **Browser detection** -- scans ~30 paths for `DevToolsActivePort` (or use `CDP_PORT_FILE` env var)
2. **Daemon spawn** -- first command to a tab spawns a background Node.js process connected via CDP WebSocket
3. **Session persistence** -- daemon holds the session open; Chrome's "Allow" modal fires once per daemon
4. **Unix sockets** -- CLI/MCP communicates with daemon via authenticated Unix sockets
5. **Auto-exit** -- daemons shut down after 20 minutes of inactivity (configurable)

```
CLI Client ──Unix Socket + Auth──> Per-Tab Daemon ──CDP WebSocket──> Chrome
MCP Server ──Unix Socket + Auth──>     (same)     ──CDP WebSocket──> Chrome
```

See [docs/architecture.md](docs/architecture.md) for the full deep dive.

## Documentation

| Guide | Description |
|-------|-------------|
| [Getting Started](docs/getting-started.md) | Installation, connection methods, first commands |
| [Inspect & Debug](docs/inspect.md) | Screenshots, accessibility tree, refs, HTML, eval, network, performance, console |
| [Navigate & Interact](docs/navigate.md) | Navigation, clicking, typing, scrolling, drag & drop, touch, dialogs |
| [Form Filling](docs/forms.md) | Fill, clear, select, check, upload, batch fill with examples |
| [Data Access](docs/data.md) | Cookies, localStorage, sessionStorage, PDF export |
| [Network Control](docs/network.md) | Throttling, interception, mocking, HAR recording |
| [Device Emulation](docs/emulation.md) | Responsive testing, geolocation, timezone, CPU throttling |
| [Security](docs/security.md) | Domain filtering, CDP blocklist, audit log, best practices |
| [Advanced](docs/advanced.md) | Script injection, code coverage, tracing, heap snapshots, WebAuthn |
| [Architecture](docs/architecture.md) | How it works: daemon model, connection modes, file layout |

## License

MIT
