---
name: configure
description: Sets up the subagent-router plugin's settings by asking the user what they want, then writing ~/.claude/orchestrator/config.json. Use when the user asks to configure, set up or change the plugin's settings, when they ask what a setting does, or when the session start said no settings file exists yet.
allowed-tools: Bash(node:*)
argument-hint: "[a setting to change, for example \"turn Codex off\"]"
---

Set up the plugin by talking to the user, then write the file for them. Never hand-edit the JSON: the command below checks every value first, so a wrong value is refused instead of being written and ignored later.

## Start by reading what is there now

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orch-config.mjs" show
```

The `source` column says where each value comes from: `file` is the settings file, `default` is the built-in value, and `session` means a variable is overriding the file for this session only. If `show` reports that the file cannot be read, stop and tell the user. Do not write over a file that may hold settings they meant to keep.

If the user named a change in their message, for example "turn Codex off", make that change and stop. Do not run the whole interview.

## The interview

Ask **one question at a time** and wait for the answer before the next one. Skip any question the user has already answered. Six questions cover what matters; the rest of the settings are fine at their defaults.

1. **Jev.** The routing needs Jev, a classifier on TypeSafe's paid API (about $0.00005 per call). While it is on, the brief of each routed subagent call goes to TypeSafe, and briefs can hold code. So does the `Verification:` part of each answer from the plugin's own workers, which can quote test output. It is off until the user says yes; then set `jevEnabled=true`. If they say no, the plugin's workers still run on the models of their agent files, and the question about agents that must keep their model does not matter.
2. **Codex.** Does the user want the plugin to use the Codex CLI as well as Claude? It is off until they say yes, and it needs the Codex CLI installed and logged in. If they say no, skip questions about credits.
3. **Credits**, only if Codex is on. When the weekly Codex allowance is used up, Codex keeps working and charges bought credits. The plugin refuses that by default. Ask whether a job may spend credits. Say plainly that this is real money, unlike the two subscriptions.
4. **Mode.** `enforce` lets the hook change a route. `shadow` asks the classifier and writes down what it would have done, changing nothing. Recommend `shadow` for the first day to anyone who wants to see the decisions before trusting them, and `enforce` otherwise.
5. **Agents that must keep their model.** Some agents are deliberately on a small model, for example a narrow yes-or-no check. The classifier sees only the brief, never the agent file, so it would move such an agent to a larger model. Ask whether the user has any, and take exact agent type names.
6. **Briefs in the log.** The log keeps the text of briefs so the routing can be judged later. Briefs can hold code and project rules. Ask whether that is acceptable. If it is not, set `promptLogChars` to 0, which keeps the routing facts and drops the text.

## Write the answers

Write everything in one command, so either all of it lands or none of it does:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orch-config.mjs" set jevEnabled=true codexEnabled=true mode=shadow
```

A list is one comma-separated value: `keepModelAgents=spec-compliance-reviewer,plan-reviewer`. An empty value clears the list. To put a setting back to its built-in value, use `unset`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/orch-config.mjs" unset limitGate
```

To explain a setting without changing it, use `explain <key>`, or `explain` for the whole list.

## Finish

1. Tell the user that an open session keeps its old settings until it starts again.
2. Run the setup check and report anything that is not `OK`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/setup-check.mjs"
```

## The classifier key is not a setting

The key does not belong in this file, and it must never be typed into the conversation: anything in a transcript has to be treated as exposed. If Jev is on and the setup check reports a missing key, tell the user to copy the key and run this in their own terminal, adding the `--scope` of their install: `k=$(pbpaste) && claude plugin install subagent-router@claude-subagent-router --config "typesafe_api_key=$k"; unset k; pbcopy </dev/null`. It reads the key from the clipboard, so the key is never typed or kept in the shell history. Claude Code keeps it in the Keychain or its credentials file. Then run the check again. Do not ask them to paste it, do not write it anywhere yourself, and never suggest a `.env` file in the project.
