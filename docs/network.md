# Network Control

Commands for throttling bandwidth, intercepting/mocking requests, and recording HTTP traffic.

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
chromex shot <target> /tmp/slow-loading.png
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
```

### Mock API Responses

```bash
# Mock a REST API endpoint
chromex intercept <target> mock "/api/user" '{"id":1,"name":"Test User","role":"admin"}'

# Mock an error response (the body is returned with 200 status)
chromex intercept <target> mock "/api/data" '{"error":"Not found"}'

# Mock multiple endpoints
chromex intercept <target> mock "/api/auth" '{"token":"abc123"}'
chromex intercept <target> mock "/api/profile" '{"name":"Jane"}'
```

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
chromex har <target> stop /tmp/session.har
# Output: HAR saved to /tmp/session.har (42 entries).
```

### What's Captured

Each HAR entry includes:
- Request method, URL, headers, post data
- Response status, headers, MIME type
- Timing (duration from request to response)
- Transfer size

### Use Cases

```bash
# Debug API calls during a user flow
chromex har <target> start
chromex form <target> '{"#email":"user@test.com","#password":"secret"}'
chromex click <target> "button[type=submit]"
chromex waitfor <target> ".dashboard"
chromex har <target> stop /tmp/login-flow.har

# Analyze third-party requests
chromex har <target> start
chromex nav <target> "https://example.com"
chromex wait <target> networkidle
chromex har <target> stop /tmp/third-party-audit.har

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
chromex shot $TARGET /tmp/mocked-products.png

# Clean up
chromex intercept $TARGET off
```
