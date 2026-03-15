---
description: Configure chromex auto-approve permissions in Claude Code
allowed-tools: [Read, Bash]
---

# Chromex Setup

Help the user configure auto-approve for chromex commands so the AI agent doesn't need to ask permission for every browser interaction.

## What to do

1. Read the user's Claude Code settings to check current permissions:
   ```bash
   cat ~/.claude/settings.json
   ```

2. Explain that adding an allow rule will let chromex commands run without confirmation dialogs.

3. Show the user what to add to their `settings.json` under `permissions.allow`:
   ```
   Bash(*/chromex/skills/chromex/scripts/chromex.mjs *)
   ```

4. **IMPORTANT**: Always warn the user:
   - This means ALL chromex commands will execute without asking
   - The security config (`~/.chromex/config.json`) still applies (domain filtering, CDP blocklist)
   - The audit log still records everything
   - They can remove this permission at any time

5. Do NOT modify settings.json automatically. Show the user the exact JSON and let them decide.
