# Security

Chromex is designed for AI agents interacting with real browsers. Security is a first-class concern.

## Config File

All security settings live in `~/.chromex/config.json` (auto-created on first run).

```json
{
  "commandTimeout": 15000,
  "navigationTimeout": 30000,
  "idleTimeout": 1200000,
  "allowedDomains": [],
  "blockedDomains": [],
  "blockedCdpMethods": [
    "Network.enable",
    "Network.setRequestInterception",
    "Network.setCacheDisabled",
    "Page.setDocumentContent",
    "Security.disable",
    "Security.setIgnoreCertificateErrors",
    "Fetch.enable",
    "Fetch.fulfillRequest",
    "Fetch.continueRequest",
    "Browser.close",
    "Browser.crashGpuProcess",
    "Target.disposeBrowserContext",
    "SystemInfo.getProcessInfo",
    "Storage.clearDataForOrigin",
    "Storage.getCookies",
    "IndexedDB.requestData"
  ],
  "auditLog": true,
  "socketAuth": true,
  "defaultScreenshotPath": "/tmp/screenshot.png"
}
```

## Domain Filtering

Control which websites the agent can access.

### Blocklist Mode (default)

Block specific sensitive domains:

```json
{
  "blockedDomains": [
    "mail.google.com",
    "bank.example.com",
    "1password.com",
    "lastpass.com"
  ]
}
```

Tabs matching blocked domains show `[BLOCKED]` in `list` and refuse all commands:
```
6BE827FA  My Bank - Account         https://bank.example.com [BLOCKED]
A3F1C920  GitHub Dashboard          https://github.com
```

Navigation to blocked domains is also rejected:
```bash
chromex nav <target> "https://bank.example.com"
# Error: Domain "bank.example.com" is blocked.
```

### Allowlist Mode

If `allowedDomains` is non-empty, **only** those domains are accessible. Everything else is blocked.

```json
{
  "allowedDomains": [
    "example.com",
    "httpbin.org",
    "localhost"
  ]
}
```

Subdomain matching works: `"example.com"` allows `www.example.com`, `api.example.com`, etc.

## CDP Method Blocklist

The `evalraw` command can send arbitrary CDP commands. Dangerous methods are blocked by default:

| Method | Why Blocked |
|--------|-------------|
| `Network.enable` | Enables network interception |
| `Network.setRequestInterception` | Can modify/block requests |
| `Page.setDocumentContent` | Can replace page content |
| `Security.disable` | Disables security checks |
| `Security.setIgnoreCertificateErrors` | Bypasses TLS validation |
| `Fetch.enable` / `fulfillRequest` / `continueRequest` | Request interception |
| `Browser.close` | Closes the entire browser |
| `Browser.crashGpuProcess` | Crashes the GPU process |
| `Storage.clearDataForOrigin` | Wipes all site data |
| `Storage.getCookies` | Accesses cookies via CDP (use `cookies` command instead, which respects domain filtering) |
| `IndexedDB.requestData` | Reads IndexedDB data |

To customize, edit `blockedCdpMethods` in the config:

```json
{
  "blockedCdpMethods": [
    "Browser.close",
    "Security.disable"
  ]
}
```

## Socket Authentication

Daemon processes communicate via Unix sockets. By default, every socket connection requires a 32-byte random token for authentication.

- Token stored at `~/.chromex/run/.token` (mode 0600)
- Generated automatically on first run
- Prevents unauthorized local processes from sending commands

To disable (not recommended):
```json
{
  "socketAuth": false
}
```

## Audit Log

Every command is logged to `~/.chromex/audit.log`:

```json
{"ts":"2026-03-15T14:23:45.123Z","cmd":"eval","target":"6BE827FA1234","args":["document.title"],"ok":true}
{"ts":"2026-03-15T14:23:46.456Z","cmd":"nav","target":"6BE827FA1234","args":["https://example.com"],"ok":true}
{"ts":"2026-03-15T14:23:47.789Z","cmd":"evalraw","target":"6BE827FA1234","args":["Browser.close"],"ok":false}
```

To disable:
```json
{
  "auditLog": false
}
```

## Timeouts

| Setting | Default | Description |
|---------|---------|-------------|
| `commandTimeout` | 15000ms | Timeout for individual CDP commands |
| `navigationTimeout` | 30000ms | Timeout for page navigation |
| `idleTimeout` | 1200000ms (20min) | Daemon auto-exit after inactivity |

## Best Practices

1. **Always set `blockedDomains`** for production use — block email, banking, password managers
2. **Use `allowedDomains`** for restricted environments — only allow specific domains
3. **Keep `socketAuth` enabled** — prevents other local processes from hijacking sessions
4. **Review audit logs** periodically — detect unexpected command patterns
5. **Use named profiles** (`launch --profile test`) to isolate test sessions from your real browser data
