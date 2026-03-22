---
name: chromex
description: "Interact with local Chromium browser session via CDP. Use when asked to inspect, debug, test, scrape, fill forms, take screenshots, or interact with a page open in Chrome/Brave/Edge. Only on explicit user approval. Triggers for: 'inspect page', 'take screenshot', 'fill form', 'check browser', 'debug page', 'web vitals', 'browser automation'."
version: 1.0.0
---

# Chromex -- Chrome DevTools Protocol CLI

Zero-dependency CDP CLI for AI agents. Connects to Chrome/Brave/Edge via WebSocket. Per-tab persistent daemons, security hardened, 56 MCP tools.

## Prerequisites

- Node.js 22+ (uses built-in WebSocket)
- Chrome/Brave/Edge with remote debugging enabled:
  - Option A: `chrome://inspect/#remote-debugging` and toggle the switch
  - Option B: `chromex launch` (launches browser with debugging already enabled)

## Security Config

Config file: `~/.chromex/config.json` (auto-created on first run).

Key settings:
- `blockedDomains`: domains the agent cannot access (e.g. `["mail.google.com", "bank.example.com"]`)
- `allowedDomains`: if non-empty, ONLY these domains are accessible (whitelist mode)
- `blockedCdpMethods`: CDP methods blocked in `evalraw` (dangerous methods blocked by default)
- `socketAuth`: token-based authentication on daemon sockets (default: `true`)
- `auditLog`: log all commands to `~/.chromex/audit.log` (default: `true`)
- `commandTimeout` / `navigationTimeout` / `idleTimeout`: configurable timeouts in ms

## Script Location

All commands use the script at `skills/chromex/scripts/chromex.mjs` relative to the plugin root.

## Commands

The `<target>` is a **unique** targetId prefix from `list`; copy the full prefix shown (e.g. `6BE827FA`). The CLI rejects ambiguous prefixes.

### Pages & Browser

```bash
chromex.mjs list                                    # list open pages
chromex.mjs open    <url>                           # open new tab
chromex.mjs close   <target>                        # close tab
chromex.mjs focus   <target>                        # activate/focus tab
chromex.mjs launch  [--incognito] [--browser NAME]  # launch browser with debugging
chromex.mjs launch  --headless --url URL            # headless mode for CI/CD
chromex.mjs launch  --proxy socks5://host:port      # launch with proxy
chromex.mjs launch  --insecure                      # ignore certificate errors
chromex.mjs launch  --chrome-arg FLAG               # pass custom Chrome flag
chromex.mjs incognito [url]                         # isolated context (no relaunch)
chromex.mjs stop    [target]                        # stop daemon(s)
```

### Inspect

```bash
chromex.mjs snap    <target>                    # accessibility tree (prefer over html)
chromex.mjs snap    <target> --refs             # with interactive refs (@e1, @e2...)
chromex.mjs snap    <target> --refs --full      # force full snapshot (skip diff)
chromex.mjs snap    <target> --depth=2          # limit tree depth
chromex.mjs html    <target> [selector]         # full page or element HTML
chromex.mjs shot    <target> [file] [--full]    # screenshot (viewport or full page)
chromex.mjs shot    <target> --format=jpeg --quality=80  # JPEG/WebP with quality
chromex.mjs shot    <target> @e5               # screenshot of specific element by ref
chromex.mjs net     <target>                    # list network requests (CDP tracked)
chromex.mjs net     <target> <requestId>        # request detail: headers, timing, body
chromex.mjs perf    <target>                    # Core Web Vitals + memory + DOM
chromex.mjs console <target> [ms]               # capture console output (live, default 5s)
chromex.mjs console <target> list               # stored messages since daemon start
chromex.mjs console <target> detail <id>        # message detail with stack trace
chromex.mjs domsnapshot <target> [--styles]     # structured DOM with bounding rects
chromex.mjs highlight <target> <sel|clear>      # highlight element with overlay
```

### Evaluate

```bash
chromex.mjs eval    <target> <expr>             # evaluate JS expression
chromex.mjs evalraw <target> <method> [json]    # raw CDP command
```

### Navigate & Wait

```bash
chromex.mjs nav     <target> <url>              # navigate and wait for load
chromex.mjs nav     <target> back               # go back in history
chromex.mjs nav     <target> forward            # go forward in history
chromex.mjs nav     <target> reload             # reload page
chromex.mjs nav     <target> reload-hard        # reload ignoring cache
chromex.mjs waitfor <target> <selector> [ms]    # wait for CSS selector
chromex.mjs wait    <target> <event> [ms]       # wait for: networkidle, load, domready, fcp
chromex.mjs scroll  <target> <dir> [amount]     # scroll: up, down, top, bottom, to <sel>
```

### Interact

```bash
chromex.mjs click   <target> <selector|@eN>     # click by selector or ref
chromex.mjs click   <target> @e5 --dbl          # double-click by ref
chromex.mjs clickxy <target> <x> <y> [--dbl]   # click at CSS pixel coords
chromex.mjs key     <target> <combo>            # press key: Enter, Tab, Escape, Control+A
chromex.mjs type    <target> <text>             # type text (works cross-origin)
chromex.mjs hover   <target> @eN                # hover by ref
chromex.mjs drag    <target> <from> <to>        # drag & drop (selectors or coords)
chromex.mjs touch   <target> <gesture> [args]   # tap, swipe, pinch, longpress
chromex.mjs dialog  <target> accept|dismiss|auto # handle alert/confirm/prompt
chromex.mjs loadall <target> <selector> [ms]    # click "load more" until gone
```

### Forms

```bash
chromex.mjs fill    <target> <sel|@eN> <value>  # fill input/textarea
chromex.mjs clear   <target> <selector>         # clear input field
chromex.mjs select  <target> <selector> <value> # select dropdown option
chromex.mjs check   <target> <selector> [bool]  # toggle checkbox/radio
chromex.mjs form    <target> <json>             # batch: {"#email":"x","#terms":true}
chromex.mjs upload  <target> <selector> <files> # upload file(s) to input[type=file]
```

### Data

```bash
chromex.mjs cookies <target> [list|set|clear]   # cookie management
chromex.mjs storage <target> local|session|clear # browser storage
chromex.mjs pdf     <target> [file]             # export as PDF
```

### Network

```bash
chromex.mjs throttle <target> <preset|reset>    # 3g, slow-3g, 4g, offline, custom
chromex.mjs intercept <target> <action> [args]  # block, mock, on, off, rules
chromex.mjs har     <target> start|stop [file]  # record HTTP traffic as HAR
```

### Emulate

```bash
chromex.mjs emulate  <target> <device|reset>    # iphone-14, pixel-7, ipad-pro, etc.
chromex.mjs resize   <target> <w> <h> [dpr]    # custom viewport dimensions
chromex.mjs geo      <target> <lat> <lon>|reset # geolocation override
chromex.mjs timezone <target> <tz|reset>        # timezone (e.g. America/Sao_Paulo)
chromex.mjs locale   <target> <locale|reset>    # locale (e.g. pt-BR)
chromex.mjs cpu      <target> <rate|reset>      # CPU throttle (4=4x slower)
```

### Advanced

```bash
chromex.mjs inject   <target> <script|flags>    # JS injection on every page load
chromex.mjs download <target> allow|deny|reset  # download control
chromex.mjs coverage <target> start|stop        # CSS/JS code coverage
chromex.mjs trace    <target> start|stop [file] # performance trace
chromex.mjs heap     <target> snapshot [file]   # heap snapshot (memory analysis)
chromex.mjs webauthn <target> enable|creds|dis  # virtual passkey authenticator
```

### Audit & Analytics

```bash
chromex.mjs audit   <target> [categories] [device]  # Lighthouse audit (perf, a11y, seo)
chromex.mjs audit   <target> accessibility desktop   # specific category + device
chromex.mjs stats   <target>                    # session analytics (commands, timing, errors)
chromex.mjs stats   <target> --full             # full timeline
chromex.mjs stats   <target> --reset            # reset counters
chromex.mjs stats   <target> --export=/tmp/s.json  # export as JSON
```

## Ref-Based Selection

Use `snap --refs` to assign @e1, @e2... to interactive elements, then interact by ref:

```bash
chromex.mjs snap <target> --refs    # @e1 [textbox] Email, @e2 [button] Submit...
chromex.mjs fill <target> @e1 "user@example.com"
chromex.mjs click <target> @e2
chromex.mjs hover <target> @e3
```

## Coordinates

`shot` saves at native resolution: image px = CSS px x DPR. `clickxy` takes CSS pixels.

## Auto-Snapshot

Interactive commands (`click`, `clickxy`, `fill`, `type`, `key`, `navigate`, `select`, `check`, `clear`, `form`, `dialog`, `loadall`, `drag`, `touch`, `upload`) automatically append an incremental snapshot with refs after executing. This means:

- **No need to call `snap` after interacting** -- the page state is already in the response
- The returned refs (`@eN`) are immediately usable for the next action
- Navigate resets the snapshot cache, so the first post-navigation snapshot is always full

**Workflow (before):** `snap --refs` -> read refs -> `click @e5` -> `snap --refs` -> read refs -> `click @e8`
**Workflow (now):** `snap --refs` -> read refs -> `click @e5` -> read refs from response -> `click @e8`

To disable auto-snapshot (e.g. for rapid scripting), pass `--no-snap` (CLI) or `noSnap: true` (MCP):
```bash
chromex.mjs click <target> @e5 --no-snap
```

**Note on async actions:** The auto-snapshot waits 300ms for DOM to settle after the action. If a click triggers an API call (e.g. form submit, data fetch), the snapshot may capture the loading state rather than the final result. In those cases, use `wait networkidle` after the action before relying on the returned refs.

## Snapshot Enhancements

**New element markers:** In incremental snapshots, elements that did not exist in the previous snapshot are prefixed with `*`. This helps identify what changed after an action:
```
[incremental: 2 changed, 14 unchanged]
@e5 [textbox] Login = "user@test.com"
  *[StaticText] user@test.com          <-- new element
```

**Scroll detection:** Snapshots include a `[scroll]` footer showing scrollable containers and how much hidden content remains:
```
[scroll: page: down:2330px | sidebar: down:800px, up:200px]
```
This tells you there is content below/above that requires `scroll` to reveal. Only reports containers with `overflow: auto|scroll` and >50px of hidden content.

## Tips

- Prefer `snap --refs` for AI agents -- refs are stable, concise, no CSS selectors needed
- Prefer `snap` over `html` for page structure
- After `click`/`fill`/`type`, read the auto-snapshot in the response instead of calling `snap` again
- Only call `snap` explicitly when: (1) starting a new page, (2) after `wait`/`waitfor`, (3) after `scroll`
- Check `[scroll]` footer to know if there is hidden content that needs scrolling
- Use `waitfor` before interacting with dynamically-loaded elements
- Use `fill` for form fields -- handles React/Vue/Angular controlled inputs
- Use `launch` to skip Chrome's "Allow debugging" modal entirely
- Use `wait networkidle` for SPAs that load data asynchronously
- Use `intercept mock` to test with fake API responses
- `dialog auto` prevents alert/confirm from blocking automation
- Audit log at `~/.chromex/audit.log` records all commands
