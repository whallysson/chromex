# Inspect & Debug

Commands for reading page content, taking screenshots, inspecting DevTools state, prioritizing runtime failures, and measuring performance.

## Screenshots

Capture the visible viewport or the entire page.

```bash
# Viewport screenshot (what you see on screen)
chromex shot <target>

# Full page screenshot (captures everything, including below the fold)
chromex shot <target> ~/.chromex/screenshots/full.png --full

# Default path: ~/.chromex/artifacts/<workspace>/screenshots/screenshot-<timestamp>.png
chromex shot <target>
```

**Output:**
```
~/.chromex/artifacts/<workspace>/screenshots/screenshot-<timestamp>.png
Screenshot saved (viewport only). DPR: 2
Coordinate mapping: CSS px = screenshot px / 2
  e.g. screenshot (200, 400) -> clickxy <target> 100 200
  On this 2x display: CSS px = screenshot px * 0.5
```

### Coordinate System

Screenshots are saved at native resolution. On a Retina display (DPR=2), a 1440x900 viewport produces a 2880x1800 image.

To convert screenshot coordinates to CSS pixels for `clickxy`:
```
CSS px = screenshot px / DPR
```

The `shot` command always prints the DPR and conversion hint.

## Accessibility Tree

Get a compact representation of the page structure. **Preferred over `html` for AI agents** — it's smaller, more structured, and focuses on interactive elements.

```bash
chromex snap <target>
```

**Output:**
```
[RootWebArea] Example Domain
  [heading] Example Domain
    [StaticText] Example Domain
  [paragraph]
    [StaticText] This domain is for use in illustrative examples...
  [link] More information...
    [StaticText] More information...
```

### Interactive Refs (`--refs`)

The `--refs` flag assigns numbered refs to every interactive element. This is the **killer feature for AI agents** — instead of fragile CSS selectors, use stable ref numbers.

```bash
chromex snap <target> --refs
```

**Output:**
```
          [StaticText] Customer name:
          @e1 [textbox] Customer name:
          [StaticText] Telephone:
          @e2 [textbox] Telephone:
      [group] Pizza Size
          @e3 [radio] Small
          @e4 [radio] Medium
          @e5 [radio] Large
      [group] Pizza Toppings
          @e6 [checkbox] Bacon
          @e7 [checkbox] Extra Cheese
        @e8 [button] Submit order
```

Then interact using refs:
```bash
chromex fill  <target> @e1 "John Doe"     # fill textbox
chromex click <target> @e5                 # select "Large" radio
chromex click <target> @e6                 # check "Bacon"
chromex hover <target> @e8                 # hover submit button
chromex click <target> @e8                 # submit
```

Refs are assigned to: buttons, links, textboxes, checkboxes, radios, comboboxes, menu items, tabs, switches, sliders, spinbuttons, options, and tree items.

Refs persist until the next `snap --refs` call. The short alias `-i` also works: `snap <target> -i`.

### When to Use `snap` vs `html`

| Use `snap` when... | Use `html` when... |
|---|---|
| You need page structure | You need exact HTML markup |
| You're an AI agent parsing the page | You need CSS classes or attributes |
| The page has lots of content | You need a specific element's HTML |
| You want a compact representation | You're debugging HTML/CSS issues |

## HTML Extraction

Get the full page HTML or a specific element.

```bash
# Full page HTML
chromex html <target>

# Specific element by CSS selector
chromex html <target> "nav.main-nav"
chromex html <target> "#content"
chromex html <target> "form.login-form"
```

**Output:**
```html
<nav class="main-nav">
  <a href="/">Home</a>
  <a href="/about">About</a>
</nav>
```

## JavaScript Evaluation

Execute arbitrary JavaScript in the page context.

```bash
# Get page title
chromex eval <target> "document.title"

# Get current URL
chromex eval <target> "window.location.href"

# Count elements
chromex eval <target> "document.querySelectorAll('a').length"

# Extract structured data
chromex eval <target> "JSON.stringify(Array.from(document.querySelectorAll('h2')).map(h => h.textContent))"

# Get computed styles
chromex eval <target> "getComputedStyle(document.body).backgroundColor"

# Check if an element is visible
chromex eval <target> "document.querySelector('.modal')?.offsetParent !== null"
```

> **Tip:** For complex expressions, wrap in an IIFE:
> ```bash
> chromex eval <target> "(function() { const items = []; document.querySelectorAll('li').forEach(li => items.push(li.textContent.trim())); return JSON.stringify(items); })()"
> ```

## Raw CDP Commands

Send any Chrome DevTools Protocol command directly. Some dangerous methods are blocked by default (see [Security](./security.md)).

```bash
# Get document structure
chromex evalraw <target> "DOM.getDocument"

# Get page layout metrics
chromex evalraw <target> "Page.getLayoutMetrics"

# Get all cookies for the page
chromex evalraw <target> "Network.getCookies" '{"urls":["https://example.com"]}'

# Enable the DOM domain
chromex evalraw <target> "DOM.enable"
```

> See the full [CDP Protocol Reference](https://chromedevtools.github.io/devtools-protocol/) for all available methods.

## Browser Issues

Collect issues reported by Chrome's Audits domain, including cookie, mixed-content, CORS, attribution, deprecation, and form signals supported by the active Chromium build.

```bash
chromex issues <target> enable
chromex issues <target> list
chromex issues <target> check-forms
chromex issues <target> clear
chromex issues <target> disable
```

Collection starts automatically when `list` or `check-forms` is called. Keep the same tab daemon alive while reproducing the problem so events remain available.

## CSS, Listeners, and Box Model

Inspect a selected element without constructing raw CDP calls:

```bash
chromex inspect <target> computed "#checkout"
chromex inspect <target> computed "#checkout" color
chromex inspect <target> matched "#checkout"
chromex inspect <target> listeners "#checkout"
chromex inspect <target> box "#checkout"
chromex inspect <target> all "#checkout"
```

`computed` and `matched` accept an optional property-name filter. `all` returns computed styles, matched rules, event listeners, and content/padding/border/margin geometry in one call.

## Prioritized Runtime Diagnosis

`diagnose` combines Browser Issues, failed or HTTP-error requests, console errors and warnings, plus selected runtime counters from the current daemon window.

```bash
chromex issues <target> enable
chromex diagnose <target>
chromex diagnose <target> 50
```

The result is a prioritization aid, not a synthetic score for release approval. Reproduce the flow first so the daemon has captured its network, console, and issue events.

## Network Performance

View requests captured since the per-tab daemon started. On a fresh non-daemon fallback, Chromex can return browser resource timing entries instead.

```bash
chromex net <target>
chromex net <target> --failed --status=4xx
chromex net <target> --url=/api/ --method=POST --limit=20
chromex net <target> <requestId>
chromex net <target> <requestId> --body-limit=100000
```

**Output:**
```
STATUS  METHOD  ID              URL
   200  GET     1234.1          https://example.com/app.js
   503  POST    1234.2          https://example.com/api/checkout
```

Request detail includes method, URL, status, MIME type, request and response headers, request body, response body when Chrome still has it, DNS/connect/TLS/TTFB timing, initiator, protocol, cache state, encoded length, and failure data. Sensitive values are redacted by default; use `--include-sensitive` only for the exact live call that requires them.

## Performance Metrics

Get Core Web Vitals and detailed performance data.

```bash
chromex perf <target> summary
```

**Output:**
```
## Core Web Vitals
LCP:  1250ms  (IMG) [GOOD]
INP:  120ms [GOOD]
FCP:  890ms [GOOD]
CLS:  0.05 [GOOD]
TTFB: 120ms [GOOD]

## Navigation Timing
DOM Interactive:       450ms
DOMContentLoaded:      520ms
Load:                  1300ms

## Resources
Total requests:  42
Transfer size:   1.2MB

## Memory
JS Heap Used:  12.5MB
JS Heap Total: 18.0MB

## DOM
DOM Nodes:     1523
Documents:     3
Frames:        2
Listeners:     89
```

The summary also reports long tasks, long animation frames, layout shifts, and event timing counts. Metrics are rated `[GOOD]`, `[NEEDS IMPROVEMENT]`, or `[POOR]` using the thresholds encoded by Chromex. See [Advanced Features](./advanced.md) for explicit collection windows, CPU profiles, allocation sampling, traces, and heap analysis.

## Console Capture

Listen to `console.log`, `console.error`, `console.warn` for a specified duration.

```bash
# Listen for 5 seconds (default)
chromex console <target>

# Listen for 10 seconds
chromex console <target> 10000

# Listen for 30 seconds
chromex console <target> 30000

# Query stored daemon history
chromex console <target> list --type=error --query=checkout --limit=20
chromex console <target> detail <messageId>
```

**Output:**
```
[14:23:45.123] LOG  App initialized
[14:23:45.456] WRN  Deprecation warning: use newMethod() instead
[14:23:46.789] ERR  Failed to fetch: NetworkError
```

Stored detail includes stack frames when Chrome provides them. Message bodies and stack URLs are redacted by default; pass `--include-sensitive` only for a specific live inspection. For an explicit timed capture, start the command and interact with the page from another terminal.

## DOM Snapshot

Get a structured snapshot of the DOM with bounding rectangles and optional computed styles.

```bash
# Basic snapshot with layout info
chromex domsnapshot <target>

# Include computed styles (display, visibility, opacity, etc.)
chromex domsnapshot <target> --styles
```

**Output:**
```
  <html>
  <html>  [0,0 1200x800]
    <head>
    <body>  [8,21 1184x760]
      <h1>  [8,21 1184x37]
        "Welcome to Example"
      <div id="content" class="main">  [8,80 1184x680]
        <p>  [8,80 1184x24]
          "This is the main content..."
```

Each element shows: tag, key attributes (id, class, name, type, href, src, role), and bounding rect `[x,y widthxheight]`.

## Element Highlight

Highlight an element with a visual overlay — like the element inspector in DevTools.

```bash
# Highlight an element (shows content, padding, border, margin areas)
chromex highlight <target> "h1"
chromex highlight <target> "#main-content"
chromex highlight <target> ".error-message"

# Remove highlight
chromex highlight <target> clear
```

The highlight includes info tooltip showing the element's dimensions and tag name.
