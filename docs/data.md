# Data Access

Commands for managing cookies, browser storage, and exporting pages as PDF.

## Cookies

### List Cookies

Show all cookies for the current page.

```bash
chromex cookies <target>
```

**Output:**
```
session_id                      abc123def456...                               2026-03-20T15:00:00  HttpOnly Secure SameSite=Strict
_ga                             GA1.2.12345678.1234567890                     2027-03-15T10:00:00  SameSite=Lax
theme                           dark                                          Session
```

Columns: name, value (truncated at 40 chars), expiration, flags.

### Set a Cookie

```bash
# Minimal (uses current page's domain)
chromex cookies <target> set '{"name": "test", "value": "hello"}'

# Full options
chromex cookies <target> set '{
  "name": "session_token",
  "value": "abc123",
  "domain": ".example.com",
  "path": "/",
  "secure": true,
  "httpOnly": true,
  "sameSite": "Strict",
  "expires": 1742000000
}'
```

**Output:**
```
Cookie "test" set on example.com
```

### Clear Cookies

```bash
# Clear all cookies for the current page
chromex cookies <target> clear

# Clear cookies for a specific domain only
chromex cookies <target> clear "tracking.example.com"
```

**Output:**
```
Cleared 5 cookie(s)
Cleared 2 cookie(s) for domain tracking.example.com
```

### Common Use Cases

```bash
# Debug authentication: check if session cookie exists
chromex cookies <target>

# Test logged-out state: clear all cookies and reload
chromex cookies <target> clear
chromex nav <target> "https://example.com"

# Set a feature flag cookie
chromex cookies <target> set '{"name": "feature_beta", "value": "true"}'
chromex nav <target> "https://example.com"  # reload to apply

# Copy auth between tabs: get cookie value, set on another tab
chromex eval <target1> "document.cookie"
chromex cookies <target2> set '{"name": "session", "value": "copied_value"}'
```

## Browser Storage

### LocalStorage

```bash
# Dump all localStorage entries
chromex storage <target> local
```

**Output:**
```
theme                                     dark
user_preferences                          {"lang":"en","notifications":true,"...
cart_items                                [{"id":42,"qty":2},{"id":17,"qty":1...
last_visited                              2026-03-15T14:30:00Z
```

### SessionStorage

```bash
chromex storage <target> session
```

**Output:**
```
form_draft                                {"email":"user@test.com","name":"Jo...
scroll_position                           1250
tab_id                                    a3f1c920
```

### Clear All Storage

```bash
# Clears both localStorage AND sessionStorage
chromex storage <target> clear
```

**Output:**
```
Cleared localStorage and sessionStorage.
```

### Working with Storage via Eval

For more granular control, use `eval`:

```bash
# Get a specific localStorage value
chromex eval <target> "localStorage.getItem('theme')"

# Set a localStorage value
chromex eval <target> "localStorage.setItem('debug', 'true')"

# Remove a specific key
chromex eval <target> "localStorage.removeItem('cart_items')"

# Get storage size
chromex eval <target> "JSON.stringify(localStorage).length + ' bytes'"
```

## PDF Export

Save the current page as a PDF file. Uses Chrome's built-in print-to-PDF with background printing enabled.

```bash
# Save to specific path
chromex pdf <target> /tmp/report.pdf

# Default path: /tmp/page.pdf
chromex pdf <target>
```

**Output:**
```
PDF saved to /tmp/report.pdf
```

### PDF Features

- Prints background colors and images (`printBackground: true`)
- Respects CSS `@page` rules (`preferCSSPageSize: true`)
- Portrait orientation by default
- Standard page size (Letter)

### Use Cases

```bash
# Export an invoice
chromex nav <target> "https://app.example.com/invoices/123"
chromex waitfor <target> ".invoice-loaded"
chromex pdf <target> /tmp/invoice-123.pdf

# Export a dashboard report
chromex nav <target> "https://dashboard.example.com/weekly"
chromex waitfor <target> ".charts-rendered"
chromex pdf <target> /tmp/weekly-report.pdf

# Export documentation page
chromex nav <target> "https://docs.example.com/api"
chromex pdf <target> /tmp/api-docs.pdf
```
