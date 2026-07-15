---
description: Configure chromex auto-approve permissions in Claude Code
allowed-tools: [Read, Bash]
---

# Chromex Permission Setup

Help the user configure Claude Code permissions for Chromex CLI or MCP tools. Claude Code permission prompts are separate from Chrome's own debugging approval prompt.

## What to do

1. Read the user's Claude Code settings to check current permissions:
   ```bash
   cat ~/.claude/settings.json
   ```

2. Explain that adding an allow rule lets Claude Code run Chromex without a tool permission prompt. It does not bypass Chrome browser security.

3. For CLI usage, show the user what to add under `permissions.allow`:
   ```json
   [
     "Bash(chromex *)",
     "Bash(chromex-cli *)"
   ]
   ```

4. For MCP usage, show the MCP namespace rule:
   ```json
   ["mcp__chromex"]
   ```

5. **IMPORTANT**: Always warn the user:
   - This means ALL chromex commands will execute without asking
   - The security config (`~/.chromex/config.json`) still applies (domain filtering, CDP blocklist)
   - The audit log still records everything
   - They can remove this permission at any time
   - A recurring Chrome "Allow debugging" prompt should be handled with `chromex launch --pipe` and an isolated Chromex profile, not by weakening a personal browser profile

6. Do NOT modify settings.json automatically. Show the user the exact JSON and let them decide.
