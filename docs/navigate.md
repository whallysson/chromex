# Navigate & Interact

Commands for navigation, clicking, typing, scrolling, waiting, drag & drop, touch gestures, and dialog handling.

## Navigation

Navigate to a URL and wait for the page to fully load (fires `Page.loadEventFired` + waits for `document.readyState === 'complete'`).

```bash
chromex nav <target> "https://example.com"
chromex nav <target> "https://httpbin.org/forms/post"
```

**Output:**
```
Navigated to https://example.com
```

Navigation respects [domain filtering](./security.md) — blocked domains are rejected before the browser navigates.

## Wait for Elements

Wait for a CSS selector to appear in the DOM. Essential for Single Page Applications (SPAs) where content loads dynamically.

```bash
# Wait with default timeout (15 seconds)
chromex waitfor <target> ".results-loaded"

# Wait with custom timeout (30 seconds)
chromex waitfor <target> "#dynamic-content" 30000

# Wait for a modal to appear
chromex waitfor <target> ".modal.visible"

# Wait for a loading spinner to disappear
# (use eval to check for absence instead)
chromex eval <target> "await new Promise(r => { const check = () => document.querySelector('.spinner') ? setTimeout(check, 200) : r('gone'); check(); })"
```

**Output:**
```
Found <DIV> "Search results for chromex..." (waited 1250ms)
```

## Clicking

### Click by CSS Selector

```bash
# Click a button
chromex click <target> "button.submit"

# Click a link
chromex click <target> "a[href='/about']"

# Click by ID
chromex click <target> "#login-button"

# Click the first matching element
chromex click <target> ".card:first-child .action-btn"
```

**Output:**
```
Clicked <BUTTON> "Submit order"
```

The element is automatically scrolled into view before clicking.

### Click by Coordinates

Use CSS pixel coordinates (not screenshot pixels — see [Coordinates](#coordinates)).

```bash
# Click at position (x=100, y=200) in CSS pixels
chromex clickxy <target> 100 200

# Click the center of the viewport
chromex eval <target> "JSON.stringify({w: window.innerWidth, h: window.innerHeight})"
# Returns: {"w":1440,"h":900}
chromex clickxy <target> 720 450
```

**Output:**
```
Clicked at CSS (100, 200)
```

### Coordinates

If you're clicking based on a screenshot:

```
CSS px = screenshot px / DPR
```

For example, on a Retina display (DPR=2):
- Screenshot shows a button at pixel (400, 600)
- CSS coordinates: `chromex clickxy <target> 200 300`

The `shot` command always prints the DPR.

## Typing

Insert text at the currently focused element. Works in cross-origin iframes where `eval` can't reach.

```bash
# Focus an input first, then type
chromex click <target> "#search-input"
chromex type <target> "chromex browser automation"

# Type in a contenteditable div
chromex click <target> "[contenteditable]"
chromex type <target> "Hello from chromex!"
```

**Output:**
```
Typed 25 characters
```

> **Tip:** Use `type` (not `eval`) for cross-origin iframes. Focus the element with `click` or `clickxy` first.

## Scrolling

```bash
# Scroll down 500px (default)
chromex scroll <target> down

# Scroll down a specific amount
chromex scroll <target> down 1000

# Scroll up
chromex scroll <target> up 300

# Scroll to top of page
chromex scroll <target> top

# Scroll to bottom of page
chromex scroll <target> bottom

# Scroll to a specific element
chromex scroll <target> to "#footer"
chromex scroll <target> to ".comments-section"
```

**Output:**
```
Scrolled down 500px (position: 500px)
Scrolled to top
Scrolled to <DIV> "Comments (42)"
```

## Load More

Repeatedly click a "load more" button until it disappears. Great for infinite scroll pages.

```bash
# Click ".load-more" every 1500ms until gone (default interval)
chromex loadall <target> ".load-more"

# Custom interval (500ms between clicks)
chromex loadall <target> "button.show-more" 500

# Safety: automatically stops after 5 minutes
```

**Output:**
```
Clicked ".load-more" 12 time(s) until it disappeared
```

## Wait for Lifecycle Events

Wait for page-level events beyond CSS selectors.

```bash
# Wait for network to be idle (no pending requests)
chromex wait <target> networkidle

# Wait for page load
chromex wait <target> load

# Wait for DOMContentLoaded
chromex wait <target> domready

# Wait for First Contentful Paint
chromex wait <target> fcp

# Custom timeout (default: 30s)
chromex wait <target> networkidle 60000
```

If the event already happened (e.g. page is already loaded), the command returns immediately:
```
load already reached (readyState: complete)
```

## Drag & Drop

Drag elements by CSS selector or coordinates.

```bash
# Drag between elements
chromex drag <target> "#source-item" "#drop-zone"

# Drag by coordinates (x1,y1 to x2,y2)
chromex drag <target> 100,200 400,500
```

The drag simulates a realistic mouse movement with 5 intermediate steps and 50ms delays between each.

## Touch Gestures

Simulate mobile touch interactions. Touch emulation is automatically enabled.

```bash
# Tap at coordinates
chromex touch <target> tap 200 300

# Swipe gesture (from x1,y1 to x2,y2)
chromex touch <target> swipe 200,400 200,100    # swipe up
chromex touch <target> swipe 100,300 400,300    # swipe right

# Pinch zoom
chromex touch <target> pinch 200 300 2.0        # zoom in
chromex touch <target> pinch 200 300 0.5        # zoom out

# Long press (default 1000ms)
chromex touch <target> longpress 200 300
chromex touch <target> longpress 200 300 2000   # 2 seconds
```

> **Tip:** Combine with `emulate` for realistic mobile testing:
> ```bash
> chromex emulate <target> iphone-14
> chromex touch <target> tap 195 422
> ```

## Dialog Handling

JavaScript `alert`, `confirm`, `prompt`, and `beforeunload` dialogs pause the page until someone answers them. Chrome draws them outside the page, so they never appear in screenshots, snapshots, or screencasts. Chromex records them instead and keeps the page from silently blocking your automation.

### What Happens When a Dialog Opens

The tab daemon listens for dialogs from the moment it attaches to the tab. Every dialog lands in the dialog log with its text and outcome, including dialogs opened right before a reload or a navigation.

When a command opens a dialog, the command returns at once with the dialog text instead of waiting for the CDP timeout:

```
$ chromex click <target> "#delete"
click opened a confirm dialog #1: "Delete invoice 761?". The page waits until it is answered. Answer it with "chromex dialog <t> accept" or "chromex dialog <t> dismiss".
```

The action itself ran: the click happened and the page asked for confirmation. Do not repeat the click. Answer the dialog instead.

While a dialog is open, commands that need the page (`eval`, `snap`, `shot`, `click`, `nav`, and so on) fail right away with the same instructions, and nothing reaches the page. `dialog`, `stats`, `console list|detail`, `evidence status|replay`, `open`, `close`, `focus`, and `stop` keep working.

Dialogs that open while a command runs are listed at the end of its result:

```
Clicked <BUTTON> "Save"

dialogs[1]:
  #3 alert "Saved invoice 761" accepted (auto)
```

### Commands

```bash
# Press OK on the open dialog (a prompt keeps its default text)
chromex dialog <target> accept

# Type an answer into a prompt, then press OK
chromex dialog <target> accept "my answer"

# Press Cancel
chromex dialog <target> dismiss

# Accept dialogs as they open, including one that is already open
chromex dialog <target> auto
chromex dialog <target> auto off

# List recorded dialogs (last 50 by default, up to 200)
chromex dialog <target> log
chromex dialog <target> log --limit=10
chromex dialog <target> log --include-sensitive

# Empty the dialog log
chromex dialog <target> clear
```

`accept` and `dismiss` append an incremental snapshot with refs, like other interactive commands. `auto`, `log`, and `clear` do not. `auto` is idempotent and lasts for the life of the tab daemon. In auto mode, prompts are accepted with their default text, as pressing OK would.

Use `auto` when the flow only needs to get past dialogs, and read `dialog log` afterwards to check what they said. Leave auto mode off when the test must choose between OK and Cancel, or must type a prompt answer.

### Dialog Log

```
$ chromex dialog <target> log
dialogs[3] confirm:1 prompt:1 alert:1 auto:off
[1] 18:56:39.731 CONFIRM dismissed (command) "Delete invoice 761?"
[2] 18:56:40.470 PROMPT  accepted (command)  "Your name?" default "Ana" -> "<redacted>"
[3] 18:56:54.840 ALERT   accepted (auto)     "Saved invoice 761"
```

Times are UTC, as in `console list`. The tab daemon keeps the last 200 dialogs for as long as it runs. Use `--json` to read each entry as data:

| Field | Meaning |
|-------|---------|
| `id` | Sequence number within the tab daemon. It keeps growing after `clear`. |
| `type` | `alert`, `confirm`, `prompt`, or `beforeunload`. |
| `message` | Text shown by the dialog. |
| `defaultPrompt` | Default text of a prompt, or `null` for other types. |
| `url`, `frameId` | Frame that opened the dialog. |
| `openedAt`, `closedAt` | ISO timestamps. |
| `result` | `open`, `accepted`, `dismissed`, or `unknown` when Chrome no longer shows a dialog that never reported closing. |
| `handledBy` | `command` for `dialog accept` or `dismiss`, `auto` for auto mode, or `browser` when it was answered in the browser window, for example by a person. |
| `userInput` | Answer submitted to a prompt. |

Messages, prompt defaults, and URLs hide secret-shaped values such as `token=...`, and prompt answers show as `<redacted>`. `--include-sensitive` reveals them only in that live response.

### Evidence Packs

While an evidence pack is active, each dialog is added to the timeline with its outcome, and `dialogs.json` is written next to `console.json` and `network.json`. Both stay redacted. The replay page lists the dialogs in its timeline and links `dialogs.json`.

```bash
chromex evidence <target> start checkout
chromex dialog <target> auto
chromex click <target> @e7
chromex evidence <target> stop
```

### MCP

The `chromex_dialog` tool exposes the same actions:

| Arguments | CLI equivalent |
|-----------|----------------|
| `{ "action": "accept" }` | `dialog <target> accept` |
| `{ "action": "accept", "text": "my answer" }` | `dialog <target> accept "my answer"` |
| `{ "action": "dismiss" }` | `dialog <target> dismiss` |
| `{ "action": "auto" }` | `dialog <target> auto` |
| `{ "action": "auto", "enabled": false }` | `dialog <target> auto off` |
| `{ "action": "log", "limit": 10, "includeSensitive": true }` | `dialog <target> log --limit=10 --include-sensitive` |
| `{ "action": "clear" }` | `dialog <target> clear` |

When a tool such as `chromex_click` opens a dialog, it returns the same text, and its `structuredContent.data` carries `paused: true` with the `dialog` entry. Tools during which dialogs opened include them in `data.dialogs`.

### Limits

- A dialog that was already open before Chromex attached to the tab cannot be answered through CDP. Answer it in the browser window, or close the tab with `chromex close <target>`.
- Headless browsers have no window to click, so answer each dialog with `accept` or `dismiss`, or turn on `auto`.

## Hover

Hover over elements using refs from `snap --refs`:

```bash
chromex snap <target> --refs
# @e1 [link] Products
# @e2 [link] About
# @e3 [button] Menu

chromex hover <target> @e1    # hover to trigger dropdown
chromex waitfor <target> ".dropdown-menu"
chromex click <target> @e5    # click item in dropdown
```

## Common Patterns

### Fill a form and submit

```bash
TARGET="6BE827FA"

chromex fill $TARGET "#email" "user@example.com"
chromex fill $TARGET "#password" "secret123"
chromex click $TARGET "button[type=submit]"
chromex waitfor $TARGET ".dashboard"
```

### Scrape a list of items

```bash
TARGET="6BE827FA"

# Navigate to the page
chromex nav $TARGET "https://example.com/products"

# Wait for content to load
chromex waitfor $TARGET ".product-list"

# Extract data
chromex eval $TARGET "JSON.stringify(Array.from(document.querySelectorAll('.product')).map(p => ({name: p.querySelector('h2').textContent, price: p.querySelector('.price').textContent})))"
```

### Take a screenshot after interaction

```bash
TARGET="6BE827FA"

chromex nav $TARGET "https://example.com/dashboard"
chromex waitfor $TARGET ".chart-loaded"
chromex scroll $TARGET to ".revenue-chart"
chromex shot $TARGET ~/.chromex/screenshots/revenue.png
```

### Debug a failing page

```bash
TARGET="6BE827FA"

# Check console for errors
chromex console $TARGET 5000

# Check performance
chromex perf $TARGET

# Check network
chromex net $TARGET

# Get accessibility tree
chromex snap $TARGET
```
