# Troubleshooting

Use this guide to distinguish Chromex problems from browser, package-manager, MCP-client, and Node.js runtime problems.

## The CLI Is Still Using an Older Version

Cloning or pulling the repository does not replace an existing global package.

```bash
command -v chromex
chromex --version
```

Run the current checkout directly when comparing behavior:

```bash
node bin/chromex.mjs --version
node bin/chromex.mjs --help
```

To update from the npm registry:

```bash
npm install -g chromex-mcp@latest
hash -r
chromex --version
```

To deliberately install the current checkout instead of the published package:

```bash
npm install -g .
hash -r
chromex --version
```

Restart long-running MCP clients after an update. An MCP server that was already started continues running the old code until its process is restarted.

## Browser or CDP Connection Fails

```bash
chromex doctor
chromex list
```

If no browser endpoint is found, either launch an isolated browser through Chromex or enable remote debugging in an existing Chromium browser:

```bash
chromex launch --pipe --url https://example.com
```

For non-standard installations, set `CHROMEX_BROWSER_PATH`. For remote or authenticated CDP endpoints, use `--cdp-url`, `--cdp-endpoint`, or `--cdp-headers-file`.

## Chrome Repeatedly Shows “Allow Debugging”

This is expected when new DevTools WebSocket connections attach to a normal browser profile. Per-tab daemons reduce reconnects but do not persist or bypass Chrome's permission.

Use a Chromex-managed isolated profile and the shared debugging pipe:

```bash
chromex launch --pipe --profile agent
```

Do not weaken the security of a personal browser profile to remove the prompt.

## Node.js Shows `DEP0169` for `url.parse()`

Chromex uses the WHATWG `URL` API. Find the process and first application frame before changing Chromex or suppressing warnings:

```bash
NODE_OPTIONS=--trace-deprecation chromex --version
NODE_OPTIONS=--trace-deprecation chromex doctor
NODE_OPTIONS=--trace-deprecation chromex-mcp </dev/null
```

If these commands are clean, reproduce the warning with the exact terminal, IDE, agent, or MCP launcher that emitted it:

```bash
NODE_OPTIONS=--trace-deprecation <exact-command>
```

The first non-internal stack frame identifies the owner. Update or patch that package to use `new URL()` instead of `url.parse()`, `url.resolve()`, or `url.format(string)`. Do not use `NODE_NO_WARNINGS=1` as a fix because it hides unrelated deprecations.

## Extension Commands Are Unavailable

Chrome extension lifecycle methods require a trusted debugging pipe and the explicit unsafe extension-debugging browser flag. Launch a dedicated profile:

```bash
chromex launch --extension-tools --profile extensions --url about:blank
```

`--extension-tools` implies `--pipe`. Runtime installation accepts an unpacked extension directory, not a store package.

## WebMCP Is Unavailable

WebMCP requires a compatible visible Chrome build and an origin that exposes tools. It is not available in headless mode.

```bash
chromex launch --webmcp --profile webmcp --url https://example.com
chromex webmcp <target> list
```

If the browser was already running for that profile without WebMCP enabled, close that isolated browser or use another profile before relaunching with `--webmcp`.

## Output Is Redacted

Redaction does not change the request sent by the browser. It protects values returned to the agent. Reveal exact live values only for the call that requires them:

```bash
chromex net <target> <requestId> --include-sensitive --body-limit=100000
```

Audit logs, stats, page caches, HAR, and structured evidence remain redacted. Screenshots, HTML, traces, heap snapshots, and other raw artifacts can still contain sensitive page data.
