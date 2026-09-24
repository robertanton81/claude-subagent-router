---
name: report
description: Prints the numbers of the orchestrator's measurement store - what the hook changed, what Jev answered, the labels for a route that was too small, the durations, the review findings by author family, and Claude usage over time.
disable-model-invocation: true
allowed-tools: Bash(node:*)
argument-hint: "[--json] [--since <date>] [--project <text>]"
---

Run the report and show its output to the user exactly as it is:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orch-report.mjs" $ARGUMENTS
```

The report prints counts only. No brief, no description and no worker result is in it.

After the output, name the one number to read first: the share of dispatches that the hook changed. When it is near zero, the plugin costs TypeSafe latency and money and saves nothing, and every other number waits. Then say whether the labels for a route that was too small (retries on a bigger model, verifications that name a failure, failed Codex jobs) point at a reason in the "Changed by the hook" list.
