# Architecture

How Chromex routes CLI and MCP operations to persistent per-tab CDP sessions.

## Overview

```
┌─────────────┐    Unix Socket    ┌─────────────┐    CDP WebSocket    ┌─────────────┐
│ CLI or MCP  │ ◄──────────────► │   Daemon    │ ◄─────────────────► │   Browser   │
│   client    │    JSON + Auth   │  (per tab)  │                      │             │
└─────────────┘                   └─────────────┘                      └─────────────┘
                                       │                                   ▲
                                       └──── user-only pipe broker ────────┘
```

## Components

### CLI Client (`chromex.mjs`)

The entry point. Parses command-line arguments, resolves target prefixes, and dispatches commands to the appropriate daemon.

- Handles browser discovery, `list`, `launch`, sessions, dashboards, `incognito`, and daemon lifecycle directly
- For all other commands, connects to the daemon via Unix socket

### MCP Server (`mcp-server.mjs`)

The stdio JSON-RPC server exposes the same command core as 85 typed MCP tools. It negotiates supported MCP protocol versions, returns `structuredContent` for machine-readable results, and supports `full`, `core`, and `devtools` discovery sets. The focused sets reduce schema cost; they do not change the CLI implementation.

### Per-Tab Daemon (`daemon.mjs`)

A background Node.js process that holds a CDP WebSocket session open for a specific browser tab.

**Why a daemon?**

Chrome's `chrome://inspect` mode can show an "Allow debugging" permission dialog for every new DevTools connection. Without a daemon, short-lived CLI commands would create unnecessary reconnects and repeated prompts.

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
   b. Daemon connects to Chrome's WebSocket and the user approves Chrome's prompt when required
   c. Daemon calls Target.attachToTarget and receives a sessionId
   d. Daemon creates Unix socket
   e. CLI detects socket, connects, authenticates
4. CLI sends {cmd: "eval", args: ["document.title"]} via socket
5. Daemon calls Runtime.evaluate via CDP
6. Daemon returns {ok: true, result: "GitHub"} via socket
7. CLI prints "GitHub"
```

### CDP Client (`client.mjs`)

A zero-dependency transport client for the Chrome DevTools Protocol over WebSocket or a local Unix pipe-broker socket.

Features:
- `connect(endpoint)` — WebSocket or Unix broker connection
- `send(method, params, sessionId)` — send command with timeout
- `onEvent(method, handler)` — subscribe to CDP events
- `waitForEvent(method, timeout)` — one-shot event with cancellation
- `close()` — disconnect

### Pipe Broker (`browser-pipe-broker.mjs`)

Owns Chrome's single `--remote-debugging-pipe` connection and exposes it through a user-only Unix socket. It remaps CDP request IDs, routes session-scoped events only to the owning client, and detaches sessions owned by a client when that client disconnects.

### IPC (`ipc.mjs`)

Handles communication between the CLI client and daemon processes.

- `getOrStartTabDaemon(targetId, config)` — find or spawn daemon, return authenticated connection
- `sendCommand(conn, req)` — send JSON request, wait for response
- `stopDaemons(prefix, config)` — gracefully stop daemon(s)
- Socket authentication with 32-byte random token

### Browser Detection (`browser.mjs`)

Resolves HTTP(S), WS(S), named remote endpoints, `DevToolsActivePort` files, and Chromex pipe-broker markers.

Checks ~30 candidate paths across:
- macOS + Linux
- Brave, Chrome, Chrome Canary, Chromium, Edge, Vivaldi
- Profile root + `Default/` subfolder
- `CDP_PORT_FILE` env var override

### Configuration (`config.mjs`)

Loads `~/.chromex/config.json` with fallback to `~/.config/cdp-skill/config.json` (legacy migration).

### Command Modules (`commands/`)

Command modules expose focused functions with the signature:

```javascript
export async function commandStr(cdp, sessionId, ...args) {
  // Use cdp.send() to interact with the browser
  return "Human-readable result string";
}
```

Long-running capture state is isolated inside each per-tab daemon process. Heap analysis runs in a worker thread so large snapshot parsing does not block command IPC.

## File Layout

```
~/.chromex/
├── config.json          # Security and timeout settings
├── audit.log            # Command audit log
├── artifacts/           # Workspace-scoped screenshots, traces, heap, evidence, and replay files
├── session-data/        # Private named-session storage state
├── run/
│   ├── .token           # Socket auth token (mode 0600)
│   ├── pages.json       # Cached page list
│   ├── pipe-....sock    # User-only shared Chrome pipe broker
│   ├── 6BE827FA...sock  # Daemon socket for tab 6BE8...
│   └── A3F1C920...sock  # Daemon socket for tab A3F1...
└── profiles/
    └── testing/         # Named browser profile
        ├── DevToolsActivePort
        └── ChromexPipeActive.json
```

## Connection Modes

### Mode 1: `chrome://inspect` (browser already running)

```
Browser                              chromex
  │                                    │
  │ ← User enables remote debugging   │
  │   at chrome://inspect              │
  │                                    │
  │ ← User approves each new incoming │
  │   debugging connection as needed  │
  │         Target.attachToTarget ────►│ daemon keeps the tab session alive
  │         Runtime.evaluate ─────────►│ command executes
```

### Mode 2: `chromex launch` (browser launched with --remote-debugging-port)

```
chromex                              Browser
  │                                    │
  │ spawn --remote-debugging-port=0 ──►│ (debugging pre-enabled, no modal)
  │                                    │
  │         Target.getTargets ────────►│ list works
  │         Target.attachToTarget ────►│ attaches immediately
  │         Runtime.evaluate ─────────►│ command executes
```

### Mode 3: `chromex launch --pipe`

Chromex starts Chrome with `--remote-debugging-pipe` and owns the single pipe connection through a user-only Unix-socket broker. CLI processes, MCP, and per-tab daemons share that broker. Session-scoped CDP events are routed only to the owning client, and owned target sessions are detached when a client disconnects.

Pipe mode is recommended for repeated AI use because it avoids approval prompts without weakening the protection of a normal personal browser profile. `--extension-tools` implies pipe mode.

## Supported Browsers

| Browser | macOS | Linux |
|---------|-------|-------|
| Brave | yes | yes |
| Chrome | yes | yes |
| Chrome Canary | yes | — |
| Chromium | yes | yes |
| Microsoft Edge | yes | yes |
| Vivaldi | yes | yes |

Core CDP automation works across the supported Chromium family. Experimental domains such as Chrome Extensions and WebMCP depend on the active browser build; WebMCP additionally requires a visible compatible Chrome process launched with `--webmcp`.
