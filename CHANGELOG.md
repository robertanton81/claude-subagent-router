# Changelog

## 0.3.3

- Executable evaluation tasks can use a trusted external Node grader. The runner protects grading assets from worker writes, grades a separate code snapshot without network access, records independent evidence, and rejects stale evidence during regrading. Unsupported execution boundaries stop before a worker starts.
- Codex jobs now explicitly select read-only review or workspace-write implementation, with no approval escalation, command network access, extra writable roots or shared temporary writes.
- CI requires real execution-boundary tests on macOS and Linux. Ubuntu runners load the supplied AppArmor profile for bubblewrap without disabling AppArmor globally.

## 0.3.2

- Codex implement tasks and custom reviews now receive personal rules, parent and local instructions, recursive project rules, and allowed imports. Path conditions remain attached to rules. Skipped files and size limits are reported.

- The writer lock now covers the whole checkout, the root of the git working tree, not only the exact folder. Before, a Codex job in `repo/sub` did not stop a writer in `repo`, although both change the same files.
- The plugin's Claude writers (`implementer`, `debugger`) now take the writer lock too, in `enforce` mode. Before, only Codex jobs held it, so two background Claude writers, or a Claude writer and a Codex job, could change the same checkout at once. A second writer, a reviewer or a Codex job now waits until the Claude writer's subagent has stopped. The dispatch log names the new denial `claude_writer_busy`.

## 0.3.1

- The report counts the dispatches where the orchestrator named a model, and how often the hook ran another one, down or up, by pair. A move to or from a Codex worker is counted apart, because Haiku only runs the Codex wrapper.
- A task the orchestrator sends to a Codex worker now stays on Codex while Codex can take it (reason `codex_requested`). Before, the table kept only hard tasks on Codex, so an explicit call for a medium task moved to the Claude implementer, and the ChatGPT allowance went unused. The table still moves it when Codex is off, paused, used up, or near its limit while Claude is not, and a review still goes to the Claude reviewer when Codex wrote the change.
- While Jev is on, the session start says once per session when the limit rule cannot act, because the Claude usage sample from the status line is too old or cannot be read. The desktop app runs no status line, so there the rule stopped acting and nobody was told.
- The job runner now saves the Codex limit numbers and starts the usage-limit pause when Codex ends. Before, only the command that printed the result did this. A job that ran past the worker's last wait was never printed, so a used-up plan went unnoticed, and the next job could be paid from credits.
- The cross-review rule now sees edits by the main session. A new `PostToolUse` hook on the Claude file tools records each such edit. Before, only the plugin's writer workers counted: after a Codex change, an edit by the main session left Codex as the author, and a review that the orchestrator sent to Codex was moved to the Claude reviewer, so Claude reviewed its own change.

## 0.3.0

- **New name.** The plugin is now `subagent-router`, and the repository and marketplace are `claude-subagent-router`. The old names did not say that this is a Claude Code plugin, or what it does. Agents and skills now start with `subagent-router:`, for example `/subagent-router:setup` and `subagent-router:reviewer`.
- **To move an existing install:** run `claude plugin uninstall orchestrator@llm-orchestrator` in each project that uses it, then `claude plugin marketplace remove llm-orchestrator`, then follow the Install section of the README. Claude Code stores the TypeSafe key per plugin, so give it again with `--config typesafe_api_key=…`.
- The settings and logs stay in `~/.claude/orchestrator/`. Status line scripts write rate limits to that folder, so moving it would break routing until each user changes their status line.
- While Jev is on, the log hook asks Jev how the checks of each finished worker ended (passed, failed, not run or unclear) and logs the answer. Only the `Verification:` part of the answer is sent, at most 2,000 characters. The report uses these answers and falls back to the old word search for records without one. The word search read "0 fail" and "no errors" as failures.
- A worker report such as `**Changed files:** none`, `- Changed files: none` or `Changed files: (none)` now counts as "wrote nothing". Before, only the plain line counted, so such a worker could count as the author of a change, and the cross-review then picked a reviewer from the wrong model family.

## 0.2.3

- README, setup check and configure skill: the key goes into the plugin option with `claude plugin install … --config typesafe_api_key=…`, read from the clipboard. The earlier hint `/plugin configure` is not a documented command and did not ask for the key.

## 0.2.2

- The setup check no longer reports a key in the plugin option as missing. Claude Code passes that option only to hooks, so the check now reports where the hook found the key on its last routed call.

## 0.2.1

- README: one section "TypeSafe and Jev" says what Jev is, why the plugin uses it, how to turn it on, what it sends, and what it costs. The cost per call is about $0.00005, measured on real briefs; the old figure of $0.0001 was too high.

## 0.2.0

Changes that need an action after the update:

- **Jev is opt-in.** A new setting `jevEnabled`, off by default. While it is off, the hook sends no brief to TypeSafe and changes no route. To keep routing, run `node scripts/orch-config.mjs set jevEnabled=true` or `/orchestrator:configure`.
- **The key comes only from the plugin option or `TYPESAFE_API_KEY`.** The file `~/.config/typesafe/.env` and the Keychain item `orchestrator-typesafe` are no longer read. Move the key into the plugin option; see the README section "TypeSafe and Jev". The variable `ORCH_TYPESAFE_ENV_FILE` is gone.

## 0.1.1

- README: a "Why" section, an "Install" section before the setup, and a correct statement of the one paid API (TypeSafe).

## 0.1.0

First public release.

- Routes each `Agent` call with Jev: a worker and a model for the plugin's own workers, a model for other agent types.
- Seven workers, two of them thin wrappers that run the Codex CLI on the ChatGPT plan. Codex is off by default.
- Limit rules for the 5-hour and weekly Claude windows, fed by the status line.
- A dispatch log, a report and an offline evaluation runner.
