# Network Control

Commands for inspecting captured requests and bodies, filtering failures, throttling bandwidth, intercepting or mocking requests, and recording HTTP traffic.

## Request History and Detail

The per-tab daemon captures request lifecycle events from the moment it starts. List the most recent requests or narrow them before expanding one entry:

```bash
chromex net <target>
chromex net <target> --url=/api/ --method=POST
chromex net <target> --status=4xx --failed
chromex net <target> --type=XHR --limit=20 --cursor=0
chromex net <target> <requestId>
```

Request IDs accept an unambiguous prefix. Detail includes request and response headers, request payload, response body when still available in Chrome, DNS/connect/TLS/TTFB timing, initiator, protocol, cache state, transfer size, and failure metadata.

Text bodies default to 2,000 characters. Expand only the call that needs more data:

```bash
chromex net <target> <requestId> --body-limit=100000
chromex net <target> <requestId> --include-sensitive --body-limit=100000
```

The browser request is never modified by output redaction. Authorization, cookies, token-shaped URL parameters, body fields, and similar values are hidden from agent output by default and can be revealed only for an explicit live call.

## Network Throttling

Simulate slow or no connectivity.

```bash
# Built-in presets
chromex throttle <target> 3g           # 100ms latency, 750kbps down
chromex throttle <target> slow-3g      # 2000ms latency, 50kbps down
chromex throttle <target> 4g           # 20ms latency, 4000kbps down
chromex throttle <target> offline      # No network

# Custom settings (latency_ms, download_kbps, upload_kbps)
chromex throttle <target> custom 200 1000 500

# Remove throttling
chromex throttle <target> reset
```

### Use Cases

```bash
# Test loading states under slow network
chromex throttle <target> slow-3g
chromex nav <target> "https://example.com"
chromex shot <target> ~/.chromex/screenshots/slow-loading.png
chromex throttle <target> reset

# Test offline behavior
chromex throttle <target> offline
chromex eval <target> "navigator.onLine"  # false
chromex throttle <target> reset

# Compare performance across network speeds
for preset in 3g 4g; do
  chromex throttle <target> $preset
  chromex nav <target> "https://example.com"
  chromex perf <target>
  chromex throttle <target> reset
done
```

## Request Interception

Intercept, block, or mock HTTP requests in real-time.

### Block Requests

```bash
# Block analytics/tracking
chromex intercept <target> block "*.google-analytics.com*"
chromex intercept <target> block "*.facebook.com/tr*"

# Block images (test without images)
chromex intercept <target> block "*.png"
chromex intercept <target> block "*.jpg"

# Fail matched requests with a specific CDP network reason
chromex intercept <target> block "*.tracker.*" --abort=BlockedByClient
```

### Mock API Responses

```bash
# Mock a REST API endpoint
chromex intercept <target> mock "/api/user" --status=200 --content-type=application/json --body='{"id":1,"name":"Test User","role":"admin"}'

# Mock an error response
chromex intercept <target> mock "/api/data" --status=404 --body='{"error":"Not found"}'

# Add response headers and latency
chromex intercept <target> mock "/api/slow" --status=503 --delay=750 --header='Retry-After: 1' --body='{"error":"Unavailable"}'
```

### Remove Request Headers

```bash
chromex intercept <target> on "https://api.example.com/*" --remove-header=authorization,cookie
```

This modifies the real request and should be used only when the test explicitly needs a missing-header scenario. It is different from output redaction, which never changes browser traffic.

### Manage Rules

```bash
# List active interception rules
chromex intercept <target> rules
# Output:
# 1. BLOCK *.google-analytics.com*
# 2. MOCK /api/user -> {"id":1,"name":"Test User","role":"admin"}

# Disable all interception
chromex intercept <target> off
```

### Pattern Syntax

Patterns use glob-style matching:
- `*` matches any number of characters
- `?` matches a single character
- Matching is case-insensitive

Examples:
- `*.analytics.*` -- blocks any URL containing "analytics"
- `/api/users/*` -- matches API paths
- `https://cdn.example.com/*.js` -- matches specific JS files

## HAR Recording

Record all HTTP traffic and export as HAR (HTTP Archive) format.

```bash
# Start recording
chromex har <target> start

# Navigate and interact (all requests are captured)
chromex nav <target> "https://example.com"
chromex click <target> "a.products"
chromex waitfor <target> ".product-list"

# Stop and save
chromex har <target> stop
# Default: ~/.chromex/artifacts/<workspace>/har/network-<timestamp>.har
```

### What's Captured

Each HAR entry includes:
- Request method, URL, headers, post data
- Response status, headers, MIME type
- Timing (duration from request to response)
- Transfer size

HAR files are persistent evidence. Chromex redacts secret-shaped URLs and headers and replaces request post data with `<redacted>` before writing the file. Use live `net` detail with explicit `--include-sensitive` when an exact value is required.

### Use Cases

```bash
# Debug API calls during a user flow
chromex har <target> start
chromex form <target> '{"#email":"user@test.com","#password":"secret"}'
chromex click <target> "button[type=submit]"
chromex waitfor <target> ".dashboard"
chromex har <target> stop ~/.chromex/har/login-flow.har

# Analyze third-party requests
chromex har <target> start
chromex nav <target> "https://example.com"
chromex wait <target> networkidle
chromex har <target> stop ~/.chromex/har/third-party-audit.har

# View HAR files in:
# - Chrome DevTools > Network tab > Import
# - har-viewer.com
# - Charles Proxy
```

## Common Patterns

### Test a page under various network conditions

```bash
TARGET="6BE827FA"

for condition in 3g slow-3g 4g; do
  chromex throttle $TARGET $condition
  chromex nav $TARGET "https://example.com"
  chromex wait $TARGET load
  echo "=== $condition ==="
  chromex perf $TARGET
  chromex throttle $TARGET reset
done
```

### Mock an API and test the UI

```bash
TARGET="6BE827FA"

# Mock the API with test data
chromex intercept $TARGET mock "/api/products" '[{"id":1,"name":"Widget","price":9.99}]'

# Navigate to the page that calls the API
chromex nav $TARGET "https://app.example.com/products"
chromex waitfor $TARGET ".product-card"

# Screenshot the mocked state
chromex shot $TARGET ~/.chromex/screenshots/mocked-products.png

# Clean up
chromex intercept $TARGET off
```
