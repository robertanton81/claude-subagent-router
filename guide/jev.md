# TypeSafe and Jev

Part of the [Subagent Router documentation](../README.md#documentation).

[TypeSafe](https://typesafe.ai) is a third-party API. Its model Jev is a classifier: it writes no text, and it answers fixed questions with probabilities.

The plugin uses Jev because the routing needs a judgment about each task. Asking a Claude model would spend the same plan that the plugin tries to save. Jev answers in a few hundred milliseconds, and it costs much less than one subagent start.

## What Jev is asked

For each routed brief, Jev answers five questions:

1. What kind of task is it?
2. Does it change files?
3. Is the brief self-contained, so that a worker needs nothing from the conversation?
4. How hard is it?
5. Is the answer only right if it names every match?

A table in code, [scripts/lib/routing-table.mjs](../scripts/lib/routing-table.mjs), turns the answers into a route. The questions are in [scripts/lib/questions.mjs](../scripts/lib/questions.mjs).

When one of the plugin's workers finishes, the log hook, the plugin's hook that records the end of each worker, asks one more question about the `Verification:` part of the answer. Did the checks pass, fail or not run, or is it unclear? The report counts the answers. Without a Jev answer, the report uses a word search instead, which can read "no errors" as a failure. A count of zero, such as "0 failed" or "fail 0", counts as a pass. The report uses the word search while Jev is off, after a failed Jev call, and for older records.

## While Jev is off

Jev is off until you turn it on, like Codex. While it is off:

- The routing hook sends nothing to TypeSafe and does not look for a key.
- The hook picks no model. The main session can still pick the plugin's workers, and each runs on the model of its agent file: `searcher` on Haiku, `implementer` on Sonnet, and so on.
- The rest still works:
  - the Codex workers, which hand each task to Codex through a stored request file;
  - the move of a Codex task to Claude while Codex cannot take work;
  - the redirect of `codex:codex-rescue` while Codex is on;
  - the writer lock for the plugin's own workers;
  - the log.
- The limit rules do not act, because they work through the routing table. Nothing moves to Codex, and nothing is capped at Sonnet when Claude is near its limit.
- The report judges worker checks with the word search.

## Cost and data policy

- You pay for Jev per input token: $0.042 per million tokens for Jev 1.13. Output is free. The price is from docs.typesafe.ai/models, checked on 2026-09-24.
- In our measurements, a routed brief had about 1,000 to 1,700 tokens. So a call costs about $0.00005, or about $1 per 20,000 dispatches.
- The question about a finished worker's checks sends one short question and at most 2,000 characters. It costs less than a routing call.
- `/subagent-router:report` counts the calls and shows how many of them changed a route. When that share stays near zero, Jev costs money and saves nothing, and you can turn it off.
- TypeSafe states that Jev is not trained on customer requests. See its [data handling](https://docs.typesafe.ai/models) and [legal](https://docs.typesafe.ai/legal) pages.
