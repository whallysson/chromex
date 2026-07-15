# Advanced Features

Power-user commands for script injection, code coverage, performance and memory profiling, trace insights, heap graph analysis, screencasts, Chrome extensions, page-exposed tools, WebMCP, and WebAuthn testing.

## Script Injection

Inject JavaScript that runs **before** any page scripts on every navigation. Useful for polyfills, monitoring, API overrides, or anti-detection.

```bash
# Inject inline script
chromex inject <target> "window.__TESTING = true"

# Inject from file
chromex inject <target> --file /tmp/preload.js

# List injected scripts
chromex inject <target> --list
# Output:
# 1  window.__TESTING = true
# 2  (function() { // contents of preload.js... })()

# Remove a specific injection
chromex inject <target> --remove 1
```

### Use Cases

```bash
# Override navigator properties (anti-detection)
chromex inject <target> "Object.defineProperty(navigator, 'webdriver', {get: () => false})"

# Add performance monitoring
chromex inject <target> --file /tmp/monitor.js

# Mock browser APIs
chromex inject <target> "window.confirm = () => true; window.alert = () => {}"
```

Scripts persist across navigations within the same daemon session. They're removed when the daemon stops or when explicitly removed with `--remove`.

## Download Control

Control how the browser handles file downloads.

```bash
# Auto-accept downloads to a specific directory
chromex download <target> allow ~/.chromex/downloads

# Block all downloads
chromex download <target> deny

# Reset to default behavior
chromex download <target> reset
```

## Code Coverage

Measure how much of the loaded JavaScript and CSS is actually used.

```bash
# Start collecting coverage
chromex coverage <target> start

# Navigate and interact with the page
chromex nav <target> "https://example.com"
chromex click <target> ".menu-toggle"
chromex waitfor <target> ".dropdown-open"

# Stop and get report
chromex coverage <target> stop
```

**Output:**
```
## JavaScript Coverage
Total: 1.2MB, Used: 340.5KB (28%)

Files with <50% usage:
   12%    245.3KB  https://example.com/vendor.js
   23%    189.1KB  https://example.com/analytics.js
   45%     98.7KB  https://example.com/app.js

## CSS Coverage
Rules: 1523 total, 412 used (27%)
```

### Use Cases

```bash
# Identify dead code in production
chromex coverage <target> start
chromex nav <target> "https://example.com"
chromex wait <target> networkidle
chromex coverage <target> stop

# Measure coverage for a specific user flow
chromex coverage <target> start
chromex nav <target> "https://app.example.com/login"
chromex fill <target> "#email" "user@test.com"
chromex fill <target> "#password" "secret"
chromex click <target> "button[type=submit]"
chromex waitfor <target> ".dashboard"
chromex coverage <target> stop
```

## Performance and Allocation Profiles

The performance summary reports LCP, INP, FCP, CLS, TTFB, long tasks, long animation frames, layout shifts, navigation timing, transfer size, heap counters, DOM nodes, documents, frames, and listeners.

```bash
chromex perf <target> summary
chromex perf <target> start
chromex perf <target> stop
```

Use an explicit collection window when the metric depends on an interaction. CPU and allocation profiles are written under `~/.chromex/artifacts/<workspace>/profiles/` unless a path is provided.

```bash
chromex perf <target> cpu-start
chromex click <target> "#expensive-action"
chromex perf <target> cpu-stop

chromex perf <target> heap-sampling-start
chromex click <target> "#allocate"
chromex perf <target> heap-sampling-stop
```

CPU profiles use the `.cpuprofile` format. Heap allocation sampling uses `.heapprofile`; both can be loaded into compatible Chrome DevTools panels.

## Performance Tracing

Capture a full Chrome performance trace and analyze common bottlenecks without loading the complete trace into the agent context.

```bash
chromex trace <target> start
chromex nav <target> "https://example.com"
chromex scroll <target> bottom
chromex click <target> ".load-more"
chromex trace <target> stop
chromex trace <target> insights
```

The default artifact path is `~/.chromex/artifacts/<workspace>/traces/trace-<timestamp>.json`. The capture streams through CDP instead of retaining the complete trace in memory.

Use custom categories or inspect one finding type:

```bash
chromex trace <target> start "devtools.timeline,v8.execute,blink.user_timing"
chromex trace <target> stop ~/.chromex/custom/checkout-trace.json
chromex trace <target> insight long-task ~/.chromex/custom/checkout-trace.json
```

Available insight families depend on the trace and include long tasks, expensive layouts, GC pauses, and layout shifts. Full trace files can also be loaded into [Perfetto UI](https://ui.perfetto.dev/).

## Heap Snapshots and Graph Analysis

Heap snapshots default to `~/.chromex/artifacts/<workspace>/heap/`. Chromex analyzes them in a worker so the CLI and MCP server remain responsive.

```bash
chromex heap <target> snapshot
chromex heap <target> summary
chromex heap <target> duplicate-strings
chromex heap <target> class-nodes <snapshot> HTMLDivElement 50
chromex heap <target> dominators <snapshot> <nodeId> 50
chromex heap <target> retainers <snapshot> <nodeId> 50
chromex heap <target> retaining-paths <snapshot> <nodeId> 20 8
chromex heap <target> edges <snapshot> <nodeId> 100
chromex heap <target> details <snapshot> <nodeId>
chromex heap <target> close <snapshot>
```

`summary` and other analysis commands reuse the most recent snapshot when the file is omitted. `close` releases its parsed graph from the analysis worker.

### Memory Leak Workflow

```bash
chromex heap <target> snapshot ~/.chromex/heap/before.heapsnapshot

for i in $(seq 1 10); do
  chromex click <target> ".open-modal"
  chromex click <target> ".close-modal"
done

chromex heap <target> snapshot ~/.chromex/heap/after.heapsnapshot
chromex heap <target> compare ~/.chromex/heap/before.heapsnapshot ~/.chromex/heap/after.heapsnapshot 50
```

Snapshots can still be loaded into the Chrome DevTools Memory panel for manual exploration. They may contain strings and object data from the page and should be treated as sensitive artifacts.

## Bounded Screencasts

Screencasts capture individual frames, a manifest, and a local replay instead of producing an opaque video file.

```bash
chromex screencast <target> start --format=jpeg --quality=80 --max-frames=300
chromex screencast <target> status
chromex screencast <target> stop
chromex screencast <target> replay
```

Useful bounds include `--max-width`, `--max-height`, `--every-nth-frame`, and `--max-frames`. The default root is `~/.chromex/artifacts/<workspace>/screencasts/`.

## Chrome Extension Tooling

Extension lifecycle APIs require a dedicated browser launched with trusted pipe transport:

```bash
chromex launch --extension-tools --profile extensions --url about:blank
chromex list
chromex extensions <target> install /path/to/unpacked-extension
chromex extensions <target> list
chromex extensions <target> targets <extensionId>
chromex extensions <target> action <extensionId>
chromex extensions <target> reload <extensionId>
chromex extensions <target> uninstall <extensionId>
```

Extension storage supports `session`, `local`, `sync`, and `managed` areas:

```bash
chromex extensions <target> storage-get <extensionId> local
chromex extensions <target> storage-get <extensionId> local '["featureFlag"]' --include-sensitive
chromex extensions <target> storage-set <extensionId> local '{"featureFlag":true}'
chromex extensions <target> storage-remove <extensionId> local featureFlag
chromex extensions <target> storage-clear <extensionId> local
```

Runtime install accepts an unpacked extension directory. Storage output is redacted by default.

## Page-Exposed Developer Tools

Pages can expose developer-tool groups through the `devtoolstooldiscovery` event. Chromex discovers their JSON schemas, validates inputs, executes the selected tool, and marks the result as untrusted page output.

```bash
chromex third-party <target> list
chromex third-party <target> execute inspectState '{"scope":"checkout"}'
chromex third-party <target> execute inspectState '{"scope":"checkout"}' app-tools --include-sensitive
```

Tool names registered by multiple groups require the group name. Page-provided output must never be treated as trusted instructions.

## WebMCP

WebMCP requires a compatible visible Chrome build and an isolated browser launched with the feature enabled:

```bash
chromex launch --webmcp --profile webmcp --url https://example.com
chromex webmcp <target> list
chromex webmcp <target> execute <toolName> '{"input":"value"}'
chromex webmcp <target> status
chromex webmcp <target> cancel <invocationId>
chromex webmcp <target> disable
```

Use `--frame=<frameId>` when a tool name is registered in more than one frame and `--timeout=<milliseconds>` for long-running calls. Chromex validates the input schema, bounds the timeout, marks the result as untrusted, and redacts secret-shaped output unless `--include-sensitive` is explicit. WebMCP is not supported in headless mode.

## WebAuthn / Passkey Testing

Create virtual FIDO2 authenticators for testing passkey flows without physical hardware.

```bash
# Enable virtual authenticator
chromex webauthn <target> enable
# Output: Virtual authenticator created (id: abc123...). Passkey flows will work automatically.

# Navigate to a site with passkey support
chromex nav <target> "https://webauthn.io"

# After registration, list stored credentials
chromex webauthn <target> creds
# Output:
# 1. a3f1c920deadbeef  rpId=webauthn.io  userHandle=user123

# Disable authenticator
chromex webauthn <target> disable
```

### Features

- CTAP2 protocol with internal transport
- Resident key support (discoverable credentials)
- User verification automatically simulated
- Automatic presence simulation (no user interaction needed)

### Use Cases

```bash
# Test passkey registration flow
chromex webauthn <target> enable
chromex nav <target> "https://example.com/settings/security"
chromex click <target> ".add-passkey"
chromex waitfor <target> ".passkey-success"
chromex webauthn <target> creds

# Test passkey login flow
chromex webauthn <target> enable
chromex nav <target> "https://example.com/login"
chromex click <target> ".login-with-passkey"
chromex waitfor <target> ".dashboard"
chromex webauthn <target> disable
```
