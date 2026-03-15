# Advanced Features

Power-user commands for script injection, code coverage, performance tracing, memory analysis, and WebAuthn testing.

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
chromex download <target> allow /tmp/downloads

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

## Performance Tracing

Capture a full Chrome performance trace (equivalent to the Performance tab in DevTools).

```bash
# Start tracing with default categories
chromex trace <target> start

# Interact with the page
chromex nav <target> "https://example.com"
chromex scroll <target> bottom
chromex click <target> ".load-more"

# Stop and save trace
chromex trace <target> stop /tmp/trace.json
# Output: Trace saved to /tmp/trace.json (1523 events). Open in chrome://tracing or Perfetto UI.
```

### Custom Categories

```bash
# Trace with specific categories
chromex trace <target> start "devtools.timeline,v8.execute,blink.user_timing"
```

### Viewing Traces

1. Open `chrome://tracing` in Chrome
2. Click "Load" and select the trace file
3. Or use [Perfetto UI](https://ui.perfetto.dev/) for a modern viewer

## Heap Snapshot

Capture a snapshot of the JavaScript heap for memory leak analysis.

```bash
chromex heap <target> snapshot /tmp/heap.heapsnapshot
# Output: Heap snapshot saved to /tmp/heap.heapsnapshot (12.5MB).
```

### Viewing Snapshots

1. Open Chrome DevTools
2. Go to the **Memory** tab
3. Click "Load" and select the `.heapsnapshot` file
4. Analyze retained objects, detached DOM trees, etc.

### Memory Leak Workflow

```bash
# Take snapshot before the action
chromex heap <target> snapshot /tmp/before.heapsnapshot

# Perform the suspected leaky action multiple times
for i in $(seq 1 10); do
  chromex nav <target> "https://app.example.com/page"
  chromex click <target> ".open-modal"
  chromex click <target> ".close-modal"
done

# Take snapshot after
chromex heap <target> snapshot /tmp/after.heapsnapshot

# Compare both snapshots in Chrome DevTools Memory tab
```

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
