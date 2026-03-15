# Architecture

How chromex works under the hood.

## Overview

```
┌─────────────┐    Unix Socket    ┌─────────────┐    CDP WebSocket    ┌─────────────┐
│  CLI Client  │ ◄──────────────► │   Daemon     │ ◄─────────────────► │   Chrome     │
│  (chromex)   │    JSON + Auth   │  (per tab)   │    JSON-RPC         │   (browser)  │
└─────────────┘                   └─────────────┘                      └─────────────┘
```

## Components

### CLI Client (`chromex.mjs`)

The entry point. Parses command-line arguments, resolves target prefixes, and dispatches commands to the appropriate daemon.

- ~200 lines
- Imports all library modules
- Handles `list`, `launch`, `incognito`, `stop` directly (no daemon needed)
- For all other commands, connects to the daemon via Unix socket

### Per-Tab Daemon (`daemon.mjs`)

A background Node.js process that holds a CDP WebSocket session open for a specific browser tab.

**Why a daemon?**

Chrome's `chrome://inspect` mode shows an "Allow debugging" permission dialog the first time a client connects to a tab. Without a daemon, every single command would trigger this dialog.

The daemon solves this by:
1. Connecting once via `Target.attachToTarget`
2. Holding the session open indefinitely
3. Receiving commands via Unix socket and forwarding them over CDP
4. Auto-exiting after 20 minutes of inactivity

**Lifecycle:**

```
1. CLI runs `chromex eval 6BE8 "document.title"`
2. CLI checks for existing daemon socket at ~/.chromex/run/6BE827FA...sock
3. If no socket exists:
   a. CLI spawns: node chromex.mjs _daemon 6BE827FA... (detached)
   b. Daemon connects to Chrome's WebSocket
   c. Daemon calls Target.attachToTarget → Chrome shows "Allow" modal
   d. User clicks Allow → daemon gets sessionId
   e. Daemon creates Unix socket
   f. CLI detects socket, connects, authenticates
4. CLI sends {cmd: "eval", args: ["document.title"]} via socket
5. Daemon calls Runtime.evaluate via CDP
6. Daemon returns {ok: true, result: "GitHub"} via socket
7. CLI prints "GitHub"
```

### CDP Client (`client.mjs`)

A pure WebSocket client for the Chrome DevTools Protocol. No dependencies.

Features:
- `connect(wsUrl)` — WebSocket connection
- `send(method, params, sessionId)` — send command with timeout
- `onEvent(method, handler)` — subscribe to CDP events
- `waitForEvent(method, timeout)` — one-shot event with cancellation
- `close()` — disconnect

### IPC (`ipc.mjs`)

Handles communication between the CLI client and daemon processes.

- `getOrStartTabDaemon(targetId, config)` — find or spawn daemon, return authenticated connection
- `sendCommand(conn, req)` — send JSON request, wait for response
- `stopDaemons(prefix, config)` — gracefully stop daemon(s)
- Socket authentication with 32-byte random token

### Browser Detection (`browser.mjs`)

Finds the `DevToolsActivePort` file that Chrome writes when remote debugging is enabled.

Checks ~30 candidate paths across:
- macOS + Linux
- Brave, Chrome, Chrome Canary, Chromium, Edge, Vivaldi
- Profile root + `Default/` subfolder
- `CDP_PORT_FILE` env var override

### Configuration (`config.mjs`)

Loads `~/.chromex/config.json` with fallback to `~/.config/cdp-skill/config.json` (legacy migration).

### Command Modules (`commands/`)

Each module exports pure functions with the signature:

```javascript
export async function commandStr(cdp, sessionId, ...args) {
  // Use cdp.send() to interact with the browser
  return "Human-readable result string";
}
```

No global state, no side effects beyond CDP calls. Fully testable.

## File Layout

```
~/.chromex/
├── config.json          # Security and timeout settings
├── audit.log            # Command audit log
├── run/
│   ├── .token           # Socket auth token (mode 0600)
│   ├── pages.json       # Cached page list
│   ├── 6BE827FA...sock  # Daemon socket for tab 6BE8...
│   └── A3F1C920...sock  # Daemon socket for tab A3F1...
└── profiles/
    └── testing/         # Named browser profile
        └── DevToolsActivePort
```

## Connection Modes

### Mode 1: `chrome://inspect` (browser already running)

```
Browser                              chromex
  │                                    │
  │ ← User enables remote debugging   │
  │   at chrome://inspect              │
  │                                    │
  │         Target.getTargets ────────►│ list works (no per-tab permission)
  │                                    │
  │         Target.attachToTarget ────►│ eval/shot/etc trigger "Allow" modal
  │ ← User clicks "Allow"             │
  │         Runtime.evaluate ─────────►│ command executes
```

### Mode 2: `chromex launch` (browser launched with --remote-debugging-port)

```
chromex                              Browser
  │                                    │
  │ spawn --remote-debugging-port=0 ──►│ (debugging pre-enabled, no modal)
  │                                    │
  │         Target.getTargets ────────►│ list works
  │         Target.attachToTarget ────►│ attaches immediately (no modal!)
  │         Runtime.evaluate ─────────►│ command executes
```

**Mode 2 is recommended** because it never shows the "Allow debugging" modal.

## Supported Browsers

| Browser | macOS | Linux |
|---------|-------|-------|
| Brave | yes | yes |
| Chrome | yes | yes |
| Chrome Canary | yes | — |
| Chromium | yes | yes |
| Microsoft Edge | yes | yes |
| Vivaldi | yes | yes |
