---
name: setup
description: Checks the setup of the subagent-router plugin - the Codex login, the TypeSafe key, the status line log and the routing mode.
disable-model-invocation: true
allowed-tools: Bash(node:*)
argument-hint: "[--live]"
---

Run the setup check and show its output to the user exactly as it is:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/setup-check.mjs" $ARGUMENTS
```

The check never prints a secret. With `--live` it also sends one small test request to TypeSafe and reports the time that the request took.

After the output, list the items that are not `OK`, and for each one say the single next step from the README section "Setup".
