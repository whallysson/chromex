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

Handle JavaScript alert, confirm, and prompt dialogs.

```bash
# Accept the current dialog
chromex dialog <target> accept

# Accept with text (for prompt dialogs)
chromex dialog <target> accept "my answer"

# Dismiss the current dialog
chromex dialog <target> dismiss

# Auto-accept ALL future dialogs (persistent for this tab)
chromex dialog <target> auto
```

`auto` mode is especially useful for automation scripts where dialogs would otherwise block execution.

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
chromex shot $TARGET /tmp/revenue.png
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
