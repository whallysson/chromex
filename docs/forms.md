# Form Filling

Commands for filling inputs, selecting dropdowns, toggling checkboxes, and batch-filling entire forms.

All form commands dispatch proper DOM events (`input`, `change`) so they work with React, Vue, Angular, and other reactive frameworks.

## Fill Input / Textarea

```bash
# Fill a text input
chromex fill <target> "#username" "john_doe"

# Fill by name attribute
chromex fill <target> "input[name='email']" "john@example.com"

# Fill a textarea
chromex fill <target> "textarea.comment" "This is my review of the product."

# Fill a search box
chromex fill <target> "input[type='search']" "chromex"

# Fill a password field
chromex fill <target> "#password" "s3cur3p4ss"
```

**Output:**
```
Filled <INPUT name="email"> with "john@example.com"
```

### How It Works

1. Scrolls the element into view
2. Focuses the element
3. Selects all existing text (Cmd+A / Ctrl+A)
4. Inserts the new text via `Input.insertText`
5. Dispatches `input` and `change` events

This approach works with:
- Standard HTML inputs
- React controlled components
- Vue v-model bindings
- Cross-origin iframes (via CDP Input events)
- Password managers

## Clear Field

Remove all text from an input or textarea.

```bash
chromex clear <target> "#search"
chromex clear <target> "input[name='query']"
```

**Output:**
```
Cleared <INPUT name="query">
```

## Select Dropdown

Select an option in a `<select>` element by value or visible text.

```bash
# By option value
chromex select <target> "#country" "BR"

# By visible text
chromex select <target> "select[name='language']" "English"

# If the option is not found, shows available options
chromex select <target> "#size" "XXL"
# Error: Option not found: XXL. Available: S, M, L, XL
```

**Output:**
```
Selected "Brazil" (value="BR")
```

## Toggle Checkbox / Radio

```bash
# Check a checkbox (default: true)
chromex check <target> "#terms"

# Uncheck a checkbox
chromex check <target> "#newsletter" false

# Select a radio button
chromex check <target> "input[value='express']"
```

**Output:**
```
checkbox "terms" is now checked
radio "shipping" is now checked
```

## Batch Fill (Form)

Fill multiple fields at once with a single JSON object. Keys are CSS selectors, values are the fill values. Booleans trigger `check`, strings trigger `fill`.

```bash
# Fill an entire form in one command
chromex form <target> '{
  "#name": "John Doe",
  "#email": "john@example.com",
  "#phone": "+1234567890",
  "input[value=\"large\"]": true,
  "#terms": true
}'

# Login form
chromex form <target> '{"#username": "admin", "#password": "secret", "#remember": true}'

# Registration form
chromex form <target> '{
  "input[name=\"first_name\"]": "Jane",
  "input[name=\"last_name\"]": "Smith",
  "input[name=\"email\"]": "jane@example.com",
  "input[name=\"password\"]": "p4ssw0rd!",
  "input[name=\"confirm\"]": "p4ssw0rd!",
  "#tos": true
}'
```

**Output:**
```
Filled <INPUT name="first_name"> with "Jane"
Filled <INPUT name="last_name"> with "Smith"
Filled <INPUT name="email"> with "jane@example.com"
Filled <INPUT name="password"> with "p4ssw0rd!"
Filled <INPUT name="confirm"> with "p4ssw0rd!"
checkbox "tos" is now checked
```

Fields are filled sequentially with a 100ms pause between each, giving reactive frameworks time to update.

## Complete Form Workflow

```bash
TARGET="6BE827FA"

# 1. Navigate to the form
chromex nav $TARGET "https://example.com/signup"

# 2. Wait for form to load
chromex waitfor $TARGET "form.signup"

# 3. Batch fill the form
chromex form $TARGET '{
  "#email": "user@example.com",
  "#password": "secure123",
  "#name": "Test User",
  "#terms": true
}'

# 4. Take a screenshot to verify
chromex shot $TARGET /tmp/form-filled.png

# 5. Submit the form
chromex click $TARGET "button[type=submit]"

# 6. Wait for redirect / success message
chromex waitfor $TARGET ".welcome-message" 10000

# 7. Verify
chromex eval $TARGET "document.querySelector('.welcome-message').textContent"
```

## File Upload

Upload files to `<input type="file">` elements without the native file dialog.

```bash
# Single file
chromex upload <target> "#avatar" /tmp/photo.png

# Multiple files
chromex upload <target> "#documents" /tmp/doc1.pdf /tmp/doc2.pdf
```

**Output:**
```
Uploaded 1 file(s) to #avatar: photo.png
```

Files are validated to exist locally before the upload is attempted.

## Ref-Based Form Filling

Use refs from `snap --refs` instead of CSS selectors:

```bash
# Get refs for the form
chromex snap <target> --refs
# @e1 [textbox] Email
# @e2 [textbox] Password
# @e3 [checkbox] Remember me
# @e4 [button] Sign in

# Fill using refs
chromex fill <target> @e1 "user@example.com"
chromex fill <target> @e2 "secret123"
chromex click <target> @e3
chromex click <target> @e4
```

This is especially useful for AI agents — refs are stable, concise, and don't require knowledge of the HTML structure.

## Tips

- Use `fill` instead of `eval` to set input values — `fill` dispatches proper events that frameworks listen to
- Use `clear` before `fill` if you need to replace existing text (fill already handles this, but clear is useful on its own)
- The `form` batch command processes fields in the order they appear in the JSON
- For `<select>` elements, use `select` (not `fill`) — it changes the selected option and dispatches change events
- For checkboxes/radios, use `check` (not `click`) — it's idempotent (won't uncheck if already checked)
- Use `upload` for file inputs — it's the only way to set files without the native dialog
- Use `snap --refs` + `fill @eN` for AI agents — no CSS selectors needed
