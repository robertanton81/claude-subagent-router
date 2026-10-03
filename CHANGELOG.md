# Changelog

## 0.4.0

Review and worker instructions:

- New skill `/subagent-router:review` reviews a change on three separate axes: Standards (the repository's documented rules, plus a short list of code smells as judgement calls), Spec (what the issue or plan asked for) and Correctness (bugs). It sets the base and the target of the change before it starts, so that all axes review the same change (for uncommitted work, the target is the working tree). It names the rule files and the spec that it used and the model family that ran each part, and it never ranks one axis against another. A problem that two axes report is listed once.
- Claude may start the review skill on any review request. It always hands the review to reviewer workers and never reviews in the main session: one dispatch for a small change (about 30 changed lines or fewer) whose reviews run on Claude anyway, two dispatches otherwise. Correctness goes to Codex only when Jev is on, the mode is `enforce`, Codex is on and can take work, Jev reads the brief as a self-contained review, and the last worker that changed files in the session was not a Codex worker. With the default settings, every part runs on Claude.
- The debugger, implementer and reviewer instructions ask for evidence. The debugger needs a command that fails on the bug before any fix, and keeps a test that it saw fail on the old code. The implementer runs the brief's checks before it says "done". The reviewer reviews against a named base and never guesses one.
- The debugger has new limits. A brief can set `Writes: none`, `Writes: tests only` or `Writes: fix allowed`; without permission to fix, the debugger runs its experiments in a copy of the project in `$TMPDIR`. It stops when it cannot reproduce the bug within the brief's budget (about 25 tool calls when the brief names none) or after 3 failed fixes, and then restores every file that it changed. Its answer ends with a `Reproduction:` line and a `Cause:` line, marked confirmed or unconfirmed.
- Result formats changed. A reviewer finding line is now `- [P1] <title>: <path>:<line>`, with a colon where it used a dash. It can carry `(rule: <file>)` or `(judgement)`, and a finding that the brief lists as known goes on one line under `Known:`, without a priority tag. A script that reads the old line must be changed. The `delegate` skill's briefs can now carry `Base:`, `Writes:` and a budget in tool calls.
- The text that the Codex runner adds to a brief changed. Each new finding gets a priority by the harm it causes: `[P0]` breaks the build or loses data, `[P1]` a bug that users will hit, `[P2]` a bug in a rare case, `[P3]` a minor problem. Before, the scale said how soon to fix. A finding that the brief lists as known goes under `Known:` without a tag. An implement job puts only the final result on its Verification line, and puts extra lines, such as `Reproduction:` and `Cause:`, after Open problems.
- `THIRD_PARTY_NOTICES.md` keeps the MIT notices of the projects whose instructions these adapt.

Evaluation:

- A task can set `history: true` with `export: true`, for review tasks. Its workspace is a git clone pinned to the commit, with only a `review` branch, so the worker sees the history up to that commit and nothing later. Later commits and other branches cannot be read in the copy, also not by their id: its reflogs are emptied and objects that no ref reaches are removed. `cwd` must be the top folder of the repository; a task set that breaks this is refused before any run.
- A task set with an editing task (any task with `export: true`, review tasks included) now puts its results in a temporary folder by default, and refuses an `--out` folder where Claude Code denies writes in `dontAsk` mode, such as `~/.claude`. Before, when the results went to the default folder under `~/.claude/orchestrator` (with `ORCH_DATA_DIR` not set), an editing task could not write any file.
- In a task with `verify`, where the worker runs in the operating system's sandbox, the worker's shell commands now work when Bash is allowed (for example through `allowedTools`): Claude Code's temp folder (`CLAUDE_CODE_TMPDIR`) points to the worker's private temporary folder. Before, every shell command failed with a permission error.

Finding triage, phase 1 (off by default):

- A new background hook can split each finished review into findings, read the code that each finding cites, and ask Jev whether that code supports the finding. Its judgements reach no session, and no finding is changed. It needs `jevEnabled: true` and `triageMode: "log"`, and runs only for the checkouts listed in `triageProjects`. `reviewFormats` describes the labels of your own review agents.
- What it sends to TypeSafe, per finding: the finding's text (at most 1,500 characters), its label, the cited file path and line range, and an excerpt of the cited code (at most 6,000 characters), for at most 12 findings per request.
- Known token shapes, the password in a URL (`postgres://user:<password>@host`), the credential of an `Authorization` header and secret-like assignments are masked before anything is cut or sent (best effort). A secret-like assignment is any name that holds a word such as password, passphrase, secret, token, api key, private key or credentials (`DB_PASSWORD=`, `client_secret:`, `"apiKey":`, `api_key: str =`, Go's `apiToken :=`); only the value, and the type of an annotated name, is masked, and a harmless name such as `max_tokens` may be masked too. Each cited file is masked whole before its excerpt is cut, so a value on the line after its name is masked too.
- A finding is held back whole when its text quotes the first or the last line of a private key (PEM, PGP, SSH2 or PuTTY, also in base64), when any file that it cites holds such a line anywhere, or when it cites a file with a common credential name (such as `.env`, `prod.env`, `.npmrc`, `secrets.yml`, `serviceAccount.json`, `*.pem`, `*.p8` or `*.ppk`), which is then never read. Only regular files inside the git checkout are read; never a file with a NUL byte (binary or UTF-16), and, for a review agent's report, never a file that git ignores. When git cannot say whether a file is ignored, the file is not read either, and one line on stderr says why.
- `scripts/orch-label.mjs` evaluates the judgements on a blind sample that you label yourself, checked once against a fixed bar. `register --agent-types` can limit an evaluation to chosen reviewer types, for example Codex reviews only.
- While `triageMode` is `log` and a window is registered, the session start shows the window's progress once a day (UTC), for all sessions together. You see it, and so does the model, as session context. From day 7, a window that fills too slowly shows `TRIPWIRE` and says what to do. After the window ends, the line says to draw the sample, or to label and score it; once the version is scored, the line stops. If the labels file is damaged, the session start leaves out only this status line; the rest of its text still appears, and the error, which names the damaged file, goes to stderr and to the dispatch log.
- `triageWorktrees: true` lets a checkout in `triageProjects` cover the worktrees of its repository too. `orch-config.mjs set triageProjects=` refuses a path that could never match (missing, not in git, or below the checkout's top folder), and takes a JSON list or paths split by commas.
- A review that is one short paragraph opening with a complete clean verdict ("No actionable regressions found in commit abc.") counts as `empty`. A verdict with a qualifier such as "blocking", a `path:line`, a list or a word such as "but" counts as `unparsed`. Known limit: a finding written as a plain sentence after such a verdict is read as `empty`.
- The report shows how many distinct eligible change groups the evaluation pool holds. This is an upper bound for a new evaluation: it does not leave out groups that an earlier evaluation already showed, results of other evaluation versions, or results outside a window or population.
- `orch-config.mjs` now says that the hooks use a change from the next subagent call; only the session-start text stays until the session starts again.
- Every Codex review job that ends while the triage is on, in a listed checkout, is triaged once, from any session on this machine, also direct `orch-codex.mjs review` runs. A job that ended while the triage was off, or more than 13 days before a scan, is never sent: the end of every Codex job removes the start time while the triage is off in the shared settings file. A launcher on `Stop` and `SessionStart` starts a detached background worker that scans the job folders. It can still send for about 10 minutes after the session ends; switching the triage off in the settings file stops it before the next send. An excerpt is sent only when its bytes provably equal the reviewed code, which only a commit review allows; base, uncommitted and custom reviews are counted but send nothing. A job whose checkout is missing, or a Jev outage, is tried at most three times in all, at least an hour apart (at the next turn end or session start after the hour). The worker gets the key through a pipe and follows only the shared settings. This widens what leaves the machine for the listed checkouts.
- `job.json` records where a job came from and which code it saw (`origin`, `head`, `scope_commit`, and more). `--commit` takes 64-character ids.
- A Codex review's count is kept only for a report that parsed; a failed, empty or unparsed result, or a missing count, is unknown, never zero.
- Cost while the triage is off, which is the default: four hook entries each start one short Node process, at session start, at the end of each turn, at each subagent hand-back and at each subagent stop (that one in the background). They send nothing. At the stop of a `codex-reviewer`, the triage hook still counts the review's findings from the job's own result, on your machine only. It can wait in the background up to two minutes for the job's records; a job that failed or left no result ends the wait at once.

Fixes:

- The count of a Codex review's findings now comes from the job's own result, not from the wrapper's summary, which often had no `[P0]` to `[P3]` tags. When the result cannot be found, the report says "unknown", never zero. Codex reviews logged before 0.4.0 have no such count, so the report lists them as unknown. The report names the reason of each unknown count, such as `exit_1`, `unparsed` or `no count record`.
- In `orch-report`, the word search over a worker's Verification line no longer counts a count of zero, such as "4 passed, 0 failed" or "fail 0", as a failed check. It now also counts "failure" and "failures", so "3 passed, 2 failures" counts as failed.
- The session start now says when Jev is on but no key reached the hooks, and names the `@inline` switch when the plugin runs as a session-only copy. It also says when no usage sample exists at all.
- When Claude and Codex are both near their limits, the session start no longer says that tasks "now run on Codex". The routing then moves nothing, and the notice now says that each task takes its normal route.
- In the evaluation, the reason "fewer than 3 graded runs" no longer says that an errored run "cannot be graded". A task with `verify` grades every run, and an errored or timed-out run fails there; the reason now names both kinds of task.
- A used-up Codex plan now reads "A Codex plan window of the ChatGPT plan is used up" in the notices, the runner and the credits note. The saved numbers come from whichever Codex window is used most, which can be the 5-hour window, so "weekly" was wrong.
- The session-start fact about the two subscriptions now gives each condition of the limit rule in its own sentence. While Claude is near its limit and Codex is not, tasks that change files and have a complete brief move to Codex. While Codex is near its limit and Claude is not, hard tasks stay on Claude, and a call to the Codex implementer can move to Claude. While both are near their limits, nothing moves.
- `orch-config.mjs explain triageProjects` and `explain reviewFormats` now describe the values that `set` accepts; before, both said "a text value".

## 0.3.4

Codex reviews and questions:

- A custom review (`review --custom`, or a review that the hook moves to Codex) now returns Codex's whole answer. It runs as plain `codex exec` in the read-only sandbox, with the same limits as before. Before, it ran as `codex exec review`, which returns only a short JSON verdict, so an answer that was not a list of findings was lost, and the answer format of the brief was replaced.
- The brief of a custom review asks for the whole answer in the final message, in the brief's own format, with each finding tagged `[P0]` to `[P3]`. When Codex still writes a long answer in an earlier message, the result shows that message too.
- New command `orch-codex.mjs consult` for questions that are not code reviews, such as design questions. Codex answers in the read-only sandbox, so it changes no files, but it can read files outside the project. The command takes no writer lock.
- Only implement jobs can get a sandbox that writes. A job kind that the code does not know is refused before Codex starts.
- A scoped review (`review --uncommitted`, `--base` or `--commit`) now saves the Codex plan numbers, and its `CODEX_JOB` line shows `codex_used=`. `codex exec review` runs the review in a child thread, and Codex writes the numbers only into the session file of that thread. Before, the plugin read only the parent thread's file, so after a scoped review the plan counted as unknown, and a used-up plan could go unseen before the next job.

Documentation:

- **The README is rewritten for easier reading.** It is now a user guide: what the plugin does, install, setup, what leaves your machine, how it works, configuration and known limits. Each fact is stated once, long paragraphs are lists and tables, and each thing has one name. It is about 30 percent shorter.
- **Two new files hold the details.** `REFERENCE.md` covers how the routing decides, the writer lock, the rules near a plan's limit, how Codex jobs run, the instruction snapshot, the data folder and the report. `EVALUATION.md` covers the offline evaluation.
- **The documentation now matches the code.** Three rounds of checks against the code found 76 statements that were wrong, out of date or incomplete. Among them: the writer lock also covers the Claude writers; Jev also receives each call's description; reviews go to the other model family only while Jev is on, and at any usage; a direct call to a Codex worker moves to Claude only in `enforce` mode; work moves to Codex only while Codex is not near its own limit; `codexSpendCredits` covers the 5-hour window too; a pause without a readable time lasts one hour; the sample task set needs a `cwd` that exists before even `--dry-run` works; a task graded only by `expectRoute` never gets a verdict.
- The README shows how to see why a subagent call was not rerouted, without printing any brief.
- The setup check says "a Codex plan window" instead of "the weekly allowance", because either window counts, and it says that the hook "picks no model" while Jev is off. `orch-config explain` names consult briefs for the two rule switches and both Codex windows for `codexSpendCredits`.

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
