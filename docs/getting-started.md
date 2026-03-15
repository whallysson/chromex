# Getting Started

## Installation

### Option 1: Claude Code Plugin (recommended)

```bash
# Add the marketplace
/plugin marketplace add github:whallysson/chromex

# Install the plugin
/plugin install chromex
```

Once installed, Claude Code will automatically use chromex when you ask it to interact with your browser.

### Option 2: Standalone CLI

```bash
git clone https://github.com/whallysson/chromex.git
cd chromex
chmod +x skills/chromex/scripts/chromex.mjs

# Create an alias for convenience
alias chromex="node $(pwd)/skills/chromex/scripts/chromex.mjs"
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

# Combine flags
chromex launch --browser chrome --incognito --url https://example.com
```

### Method B: Connect to an already-running browser

1. Open your browser
2. Navigate to `chrome://inspect/#remote-debugging`
3. Toggle the switch to enable remote debugging
4. Run `chromex list` to verify the connection

> **Note:** With Method B, Chrome will show an "Allow debugging" modal the first time you access each tab. The daemon keeps the session alive so you only see this once per tab.

## Your First Commands

```bash
# 1. List all open tabs
chromex list

# Output:
# 6BE827FA  GitHub - Dashboard            https://github.com
# A3F1C920  Google Search                  https://www.google.com
# 8D4E5B12  Stack Overflow - Questions     https://stackoverflow.com

# 2. Take a screenshot of a tab (use the prefix from list)
chromex shot 6BE8 /tmp/github.png

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

```bash
# Connect to a browser launched with a custom profile
export CDP_PORT_FILE=~/.chromex/profiles/myprofile/DevToolsActivePort
chromex list
```

## Next Steps

- [Inspect & Debug](./inspect.md) — screenshots, accessibility tree, refs, HTML, eval, network, performance, console
- [Navigate & Interact](./navigate.md) — navigation, clicking, typing, scrolling, drag & drop, touch, dialogs
- [Form Filling](./forms.md) — fill, clear, select, check, upload, batch fill with examples
- [Data Access](./data.md) — cookies, localStorage, sessionStorage, PDF export
- [Network Control](./network.md) — throttling, interception, mocking, HAR recording
- [Device Emulation](./emulation.md) — responsive testing, geolocation, timezone, CPU throttling
- [Security](./security.md) — domain filtering, CDP blocklist, audit log, best practices
- [Advanced](./advanced.md) — script injection, code coverage, tracing, heap snapshots, WebAuthn
- [Architecture](./architecture.md) — how it works: daemon model, connection modes, file layout
