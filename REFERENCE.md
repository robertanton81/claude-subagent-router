# Reference

This file holds the details behind the [README](README.md): how the routing decides, the writer lock, how Codex jobs run, and what the plugin writes to disk. Read the README first. These words are explained there: main session, subagent, brief, self-contained brief, Jev, routing hook, worker, dispatch, checkout, writer, the cross-review rule and the Codex runner. "Near its limit" and "cannot take work" are explained under [When a plan is near its limit](#when-a-plan-is-near-its-limit) below.

The `node scripts/...` commands in this file run from a clone of this repository.

**Contents:** [Routing](#routing) · [The writer lock](#the-writer-lock) · [Codex](#codex) · [The data folder](#the-data-folder) · [The report](#the-report)

## Routing

### Calls the hook leaves alone

In these cases the routing hook does not route the call: the agent type and the model stay as the main session wrote them. The `reason` in the log names the case. Two things can still apply afterwards: the move of a Codex task to Claude while Codex cannot take work, and the [writer lock](#the-writer-lock).

| Case | `reason` |
| :-- | :-- |
| The call comes from inside a subagent. | `from_subagent` |
| The mode is `off`. | `mode_off` |
| Jev is off. | `jev_disabled` |
| The hook found no key. | `error_no_key` |
| The Jev call failed, for example on a timeout or an HTTP error. | a reason that starts with `error_` |
| Jev is not sure of the kind of task (below `kindGate`). | `low_confidence` |
| Jev's answers disagree, for example a search that changes files. | `answers_disagree` |
| Jev reads the task as design, or as something else. | `kind_design` or `kind_other` |
| The brief has an `orch-route: keep` line. | `keep_requested` |
| Another agent type is `statusline-setup` or `claude-code-guide`. Claude Code runs them on a fixed model. | `keep_model_agent` |
| Another agent type is on the list `keepModelAgents`. | `keep_model_agent` |
| `routeOtherAgents` is `false`, or `ORCH_ROUTE_OTHER_AGENTS=0` for one session. | `other_agent_type` |
| A call to `codex:codex-rescue` while Codex is off. | `codex_disabled` |

A call to `codex:codex-rescue` while Codex is on is not left alone. Its reason is `bypass_agent` in `enforce` mode and `would_redirect` in `shadow` mode. In `enforce` mode, the move to Claude while Codex cannot take work, or the writer lock, can then replace that reason.

### Actions in the log

Each `dispatch` record has an `action`:

| `action` | Meaning |
| :-- | :-- |
| `rewrite` | The hook changed the agent type, the model, or both. |
| `agree` | The table picked what the call already had. |
| `pass` | The hook did not route the call. The `reason` says why; see the table above. |
| `shadow` | `shadow` mode: the log shows the route that the hook would take, and the call runs unchanged. |
| `redirect` | The hook sent a call to `codex:codex-rescue` to `subagent-router:codex-implementer`. |
| `fallback` | Codex cannot take work, so the hook moved a task for a Codex worker to its Claude counterpart. |
| `deny` | The writer lock refused the call. |

### Direct calls to the plugin's workers

When the main session calls one of the plugin's workers by name, the table still routes the task like any other task of its kind. The name counts only for three workers:

- A search that the main session sends to `complete-searcher` stays there, whatever the value of `completeRule`.
- A task sent to `codex-implementer` stays on Codex while Codex can take work. It moves when Codex is near its own limit and Claude is not. It also moves when Jev reads the task as a search, a review, or a diagnosis that changes no files. The table then routes it like any other task: a search goes to `searcher`, a diagnosis to `debugger`, and a review follows the cross-review rule. That rule sends a review to the other model family than the one that wrote the change, so it can still go to the Codex reviewer.
- A review sent to `codex-reviewer` stays on Codex while Codex can take work, unless Codex wrote the change. A task that Jev reads as something other than a review is routed like any other task. For example, a task read as an implementation goes to an implementer.

A direct call to `implementer`, `debugger` or `reviewer` gets no such rule. So while Codex is on, a hard, self-contained implementation sent to `implementer` moves to Codex, and a self-contained review of a Claude change sent to `reviewer` moves to the Codex reviewer. A direct call can also get another model, for example Opus for a hard task.

### Effort

Effort is how much the model thinks before it answers.

- Each Claude worker sets its effort in its agent file. So the effort of your session does not carry over to the workers.
- Most workers use the default of their model: Sonnet 5 `high`, Opus 5.5 `medium`. The complete searcher is the exception: it runs Sonnet at `low`.
- Haiku 4.5 takes no effort setting.
- The level stays when the hook changes the model. An implementer moved to Opus runs at `high`.
- The variable `CLAUDE_CODE_EFFORT_LEVEL` overrides the level.
- The Codex workers use the model and effort of `~/.codex/config.toml`, unless the brief has a `codex-model:` or `codex-effort:` line.

### When a plan is near its limit

Three states decide these rules:

- **Claude is near its limit** when its 5-hour window or its weekly window is at `limitGate` (80 percent) or more, or when the pace rule below counts the window. This needs the status line log from the README's Setup.
- **Codex cannot take work** while it is off, while it is paused after a usage limit, or while its saved plan numbers show a window at 100 percent and `codexSpendCredits` is false.
- **Codex is near its limit** when the plan numbers that an earlier Codex job saved are at `limitGate` or more.

All rules below except "Codex cannot take work" act through the routing table, so they need Jev on.

**Notices.** In `enforce` mode, Claude Code shows a notice at most once per session for each of three events:

- A task moves off Codex because Codex cannot take work: a fallback to the Claude counterpart, or a review that the table sends to the Claude reviewer for that reason.
- A task moves to Codex because Claude is near its limit.
- The hook lowers a model from Opus to Sonnet because Claude is near its limit and Codex cannot take work.

Other moves show no notice. This includes every move by the rule for Codex near its own limit. A new session also shows a notice at its start while Claude is near its limit, or while Codex is on but cannot take work.

**Codex cannot take work.** In `enforce` mode, every task for a Codex worker runs on Claude:

- When the table does not route the call, the task runs on the Claude counterpart, `implementer` or `reviewer`, on Sonnet, and Claude Code shows a notice. This happens when Jev is off, fails or is not confident, when Jev reads the task as design or other, when its answers disagree, when the brief has `orch-route: keep`, or when the call comes from inside a subagent.
- When the table routes the call, it picks the Claude worker and the model. A hard task can then run on `implementer` on Opus. In this case only a review shows the notice.
- In `shadow` and `off` mode, the call stays on the Codex worker. The Codex runner then refuses the job while Codex is off. It also refuses the job while the plan is used up or paused, unless `codexSpendCredits` is true. The worker then answers `CODEX_FAILED`.

**Claude is near its limit, Codex can take work, and Codex is not near its own limit.** This needs Codex on. These tasks for the plugin's workers run on Codex when their brief is self-contained:

- exact edits that are not very small;
- implementations;
- debug tasks that change files.

Searches, very small edits and diagnoses that change no files stay on Claude. Such a diagnosis still runs on Opus. Reviews keep the cross-review rule at any usage. Calls to other agent types never move to Codex.

**Claude is near its limit, and Codex cannot take work.** The hook picks no model above Sonnet. A hard task and a debug task run on Sonnet, not on Opus. This holds for the plugin's workers and for other agent types. It covers only the routes that the table picks. A call that the table leaves alone can still run on Opus.

**Codex is near its limit, and Claude is not.** A hard implementation stays on Claude, on `implementer` with Opus. A direct call to the Codex implementer is no longer kept on Codex, so the table routes it like any other task. A search, an edit, an implementation or a debug task then runs on a Claude worker. A task that Jev reads as a review follows the cross-review rule, so it can still go to the Codex reviewer. In the other cases the call stays on the Codex implementer: Jev is off, fails or is not confident, Jev reads the task as design or other, its answers disagree, or the brief has `orch-route: keep`. Reviews do not change.

**Both are near their limits, and Codex can take work.** Every task takes its normal route.

**Claude is used up.** The main session is a Claude session. When your Claude plan is fully used up, that session stops, and no hook runs. You then go on in Codex by hand.

**The pace rule.** A window also counts as near its limit when its usage so far, at the same speed, would reach 100 percent before the window resets. The effect is the same as usage at `limitGate`. Two examples for the 5-hour window:

| Used | Time passed | On pace for | Near its limit |
| :-- | :-- | :-- | :-- |
| 50 percent | 2 hours | 125 percent | yes |
| 50 percent | 4 hours | 63 percent | no |

- The pace rule needs the reset times from the status line log.
- It counts only after 20 percent of a window has passed, because a projection from the first minutes is noise. `"paceAfter"` moves the 20 percent.
- When the pace rule made the difference, the notice names the pace.
- `"pacing": false` in `config.json` turns the rule off.

## The writer lock

In `enforce` mode, the routing hook stops two writers from changing the same checkout at the same time. A writer is a task that changes files. A checkout is one git working tree: the project folder with everything below it. So a writer in `repo/src` and a writer in `repo` use the same checkout. A second working tree that you create with `git worktree add` is a checkout of its own.

**Who takes the lock:**

- A Codex implement job. The lock names the job and the process that started it, so it holds from the start, before the Codex runner has written its process id. Reviews and consults take no lock.
- The plugin's Claude writers, `implementer` and `debugger`, that run as subagents. A Claude writer takes the lock when the hook lets it through. So of two Claude writers sent in one message, only the first runs.

A Codex implement job takes the lock only when the job starts, some time after its hook ran. So when a Codex writer and a Claude writer are sent in one message, the Claude writer can take the lock first, even when it was sent second. The Codex job then fails with `writer_busy`.

**What the hook denies while another writer holds the lock:**

- A call to one of the plugin's writers or reviewers.
- A call to another agent type, such as `general-purpose`, when Jev says that its task changes files. Such a call takes no lock itself. When Jev is off, fails, or is not asked, the hook cannot know that the call writes, so it lets the call run. Jev is not asked when the call comes from inside a subagent, when `routeOtherAgents` is false, when the agent type is `statusline-setup`, `claude-code-guide` or on the list `keepModelAgents`, or for a call to `codex:codex-rescue` while Codex is off.
- The log names the denial `codex_writer_busy` or `claude_writer_busy`.

**How long a lock counts:**

- A Claude writer's lock that no subagent has confirmed stops counting after 30 seconds. This covers a dispatch that was refused or never started.
- A confirmed lock counts until its subagent stops, or until one hour has passed. A writer that runs longer than one hour is not protected any more.
- The end of the session's Claude Code process does not end the lock. When you move a session to the background (the left arrow, `/bg`, or "Move to background and exit"), or the supervisor (the Claude Code process that runs background sessions) restarts it, Claude Code starts a new process for the session. A running subagent goes on in that process, and its stop there gives the lock back. In versions 0.3.2 to 0.4.0 the lock ended as soon as the recorded process had ended, so from that moment a second writer could start while the first one still changed files.
- The cost of this rule: after a real crash, when no new process takes the subagent over, the lock blocks other writers for up to one hour.
- A lock file that cannot be read stops counting 15 minutes after it was written.
- When a lock is stuck, the denial names its file in `~/.claude/orchestrator/locks/`. Remove the file only when you are sure that no writer runs: check that no subagent of that session is still running, for example in `/tasks` of the session or in `claude agents`.

The lock does not cover edits by the main session.

## Codex

### Credits and pauses

When a Codex plan window, the 5-hour or the weekly one, reaches 100 percent, Codex does not stop. It goes on and spends your bought credits. The plugin blocks that by default:

- **The plan is used up.** While the saved plan numbers show a window at 100 percent, the plugin starts no Codex job. This ends at the reset time in those numbers. No new job can start during the block, so no newer numbers can end it earlier. Saved numbers that have no reset time do not end by themselves.
- **A job failed with a usage limit.** The plugin then starts no Codex job until the time that Codex named in its error. When the plugin cannot read a usable time there, the pause lasts one hour. It writes the end time to `~/.claude/orchestrator/codex-unavailable.json`. Delete that file to end the pause early.
- **Credits allowed.** With `"codexSpendCredits": true`, the Codex runner also starts jobs when the plan is used up or paused. In `enforce` mode, the routing hook still sends Codex tasks to Claude during a pause. So during a pause, only a job that you start by hand, such as `consult`, or a call in `shadow` or `off` mode, can spend credits.
- After each job, the `CODEX_JOB` line shows `codex_used=<percent>`. A run that was paid from credits says so, with the balance.

### Codex plan numbers

The plugin learns the plan numbers only after a Codex job that it started. So between two jobs the numbers can be out of date. The numbers come from Codex's own session file, where Codex records each run. For a scoped review (`codex exec review`), Codex runs the review in a child thread and writes the numbers only into that thread's file. The plugin finds that file by the `parent_thread_id` field on its first line. The format of these files, this field included, is internal to Codex and not a public interface, so a Codex update can change it. When the plugin cannot read the numbers, the plan counts as unknown.

### How a task reaches Codex

The Codex runner is the plugin's script that starts and watches Codex jobs. A brief is not trusted, because it can quote a web page or an issue. So it never goes into a shell command:

1. The routing hook stores the task in `~/.claude/orchestrator/codex-requests/<request id>.json`: the request file.
2. The Codex worker is a small Haiku agent that only runs commands. It receives only `codex-request: req-<12 hex characters>` and never sees the brief.
3. The worker runs `node scripts/orch-codex.mjs run <request id>`. The id has a fixed shape, and the command checks it. While the job still runs, the worker runs `wait` up to 6 times; see [Long Codex runs and failures](#long-codex-runs-and-failures).
4. The Codex runner removes `CODEX_API_KEY` and `OPENAI_API_KEY` from Codex's environment and checks `codex login status`. Without a ChatGPT login, the job stops. So a run is never billed at API rates.
5. The Codex runner adds a Claude [instruction snapshot](#instruction-snapshot) to implement, custom review and consult briefs. Codex also finds its own `AGENTS.md` files. A scoped review (`--uncommitted`, `--base`, `--commit`) gets no brief and no snapshot.

A brief can already name a request id. The hook reuses that request only when the session, the folder and the kind of job match the ones that stored it. Otherwise it stores the whole brief as a new request. The `run` command does not check the session. It always runs the stored task in the stored folder, as the stored kind of job.

**Sandbox settings.** Each Codex job gets explicit command-line settings:

- Reviews and consults run in the `read-only` sandbox. Implement jobs run in `workspace-write`. Only an implement job can get a sandbox that writes. A job kind that the code does not know is refused before Codex starts.
- Approval requests are off. Commands get no network. Extra writable folders and shared temporary folders are removed.
- These settings rely on the sandbox of the installed Codex CLI. They do not restrict the main Claude session or other tools.
- So an implement task whose checks need the network or shared temporary files fails visibly. It does not inherit looser settings from your own Codex configuration.

### Instruction snapshot

Codex does not read Claude's instruction files by itself. So the Codex runner sends a snapshot of them with implement, custom review and consult briefs.

**What loads, in this order:**

1. Personal instructions: `~/.claude/CLAUDE.md` and every Markdown file under `~/.claude/rules/`.
2. Project sources, from the filesystem root down to the task folder. Each level adds `CLAUDE.md`, `.claude/CLAUDE.md`, the files under `.claude/rules/` and its subfolders, then `CLAUDE.local.md`.

A rule keeps its YAML `paths` condition and its base folder. Codex is told to apply the rule only to matching files. The Codex runner does not enforce that condition.

**Imports:**

- An import such as `@guides/testing.md` expands relative to the file that holds it. Absolute paths and `~/` paths also work.
- An import inside backticks or a fenced code block stays literal text.
- Expansion follows at most four levels of imports, and it detects cycles.
- Import paths that contain whitespace are not supported.
- Within a checkout, project imports and symbolic links must stay inside that checkout. An ancestor folder outside the checkout may import files inside its own folder. Each imported file keeps the boundary of its source.
- Personal imports are trusted and may point anywhere.
- No import is ever followed to a common credential file, such as `.env`, `.credentials.json`, `.npmrc`, a private key file, or anything under `.git/` or `.ssh/`.
- The Codex runner cannot see which external imports you approved in Claude. So it skips a project import outside its boundary, even when you approved it.

**Limits:**

| Limit | Value |
| :-- | :-- |
| Characters per file | 16,000 |
| Characters in total | 128,000 |
| File reads | 256 |
| Import attempts | 256 |
| Levels of imports | 4 |
| Final snapshot, with labels | 160,000 characters |

The number of warnings and the search through rule folders also have limits. Sources load in the order above, so a limit can leave out the later, more specific instructions. The Codex runner records skipped sources and cuts in `job.json` under `rules`, and warns on stderr. Check these notes when a warning appears.

**What it does not include.** This is a snapshot of files, not a copy of the Claude session. It does not load instructions that Claude loads on demand from child folders, managed policy, auto memory, additional directories, or Claude settings such as `claudeMdExcludes`. Put any extra instructions that the task needs in its brief.

`codexIncludeUserRules` turns off the automatic search for personal files, and `codexIncludeProjectRules` turns it off for project files. An explicit import in a file that is still sent follows the import rules above.

### Codex reviews

A brief line `review-scope:` picks the kind of review; see the brief lines in the README.

- **A scoped review** (`uncommitted`, `base:<branch>` or `commit:<hash>`) uses Codex's own review rules. Codex refuses review instructions together with a scope flag, so a scoped review does not read the brief.
- **A custom review** sends the brief to Codex as the review instructions. It runs as a plain `codex exec` in the `read-only` sandbox. It does not use `codex exec review`, because that command returns only a short JSON verdict, and a longer answer would be lost. So Codex's final message comes back whole.

The Codex runner adds a short contract to a custom review brief:

- The task is read-only.
- The final message must hold the whole answer.
- The answer format of the brief wins.
- Each new finding gets a priority tag from `[P0]` to `[P3]` by the harm it causes, which the report counts. A finding that the brief lists as known goes under `Known:`, without a tag.

Codex sometimes writes its long answer in an earlier message and ends with a short line. The result then shows that earlier message too, with a label. A message counts when it is at least 1,000 characters long and longer than the final message.

When the routing hook moves a review from `subagent-router:reviewer` to Codex and the brief names no scope, the request gets the scope `custom`. So the brief travels as the review instructions, and none of it is lost. The dispatch record shows the scope in `review_scope`. The request file says in `scope_source` whether the scope came from the brief, from the routing or from the default.

### Ask Codex a question

For a question that is not a code review, such as a design question or a second opinion on a plan, use `consult`. The question comes on stdin, never on the command line:

```bash
node scripts/orch-codex.mjs consult --effort high < question.md
```

- Codex works in the project folder in the `read-only` sandbox, with the same settings as a review. It can also read files outside the project, and what it reads goes to OpenAI.
- A consult takes no writer lock, so it can run while a writer changes the checkout. The files that it reads can change while it reads them.
- The question gets the instruction snapshot and a short contract: the final message must hold the whole answer. The answer comes back whole, with the same rule for a long earlier message as a custom review.
- The first line of the output is `CODEX_JOB <job id> exit=0 kind=consult`.
- `wait`, `cancel`, `--model`, `--effort` and `--wait` work as for the other commands. `consult` takes no review scope.
- The routing hook never sends a task to `consult`. It is for the main session and for manual use.
- It uses the ChatGPT plan like every Codex job, with the same checks for a used-up plan and for credits.

### Long Codex runs and failures

A Codex task can run longer than the 10-minute limit of the Bash tool. So `scripts/orch-codex.mjs` starts Codex as a detached process and waits up to 9 minutes. If Codex needs longer, the command prints `STILL_RUNNING` and the exact `wait` command. The worker runs that command until the result is there. After 6 waits of 9 minutes, the worker hands the `STILL_RUNNING` text back to the main session.

```bash
node scripts/orch-codex.mjs wait <job id>
```

```bash
node scripts/orch-codex.mjs cancel <job id>
```

What happens when something goes wrong:

- **Stopping a job.** Codex runs in its own process group, with the commands that it starts. `cancel`, a timeout and the normal end all stop the whole group before the job releases the writer lock. A command that leaves the group on purpose (with `setsid`) is not covered.
- **`cancel`** stops the Codex runner and Codex. It reports success, `CODEX_CANCELLED <job id>`, only after both are gone. The job then ends with the exit code 143, or 130 when the Codex runner was already gone. The report does not count the `CODEX_CANCELLED` answer as a failed job. But a worker that still waits for the job gets `CODEX_FAILED <job id> exit=143`, and the report counts that answer as a failure.
- **`CODEX_FAILED <job id> cancel_failed`.** This has two causes, and in both the writer lock stays. Either `ps` could not tell whether a process belongs to the job, so `cancel` stopped nothing; run it again. Or some processes were still alive after SIGTERM and SIGKILL, and the message names them. Stop them by hand, then run `cancel` again.
- **`CODEX_FAILED <job id> runner_died`.** The Codex runner and Codex are both gone without an exit code. `wait` shows the output of the Codex runner from `runner.log`. The writer lock is released.
- **Only the Codex runner died.** Codex may still change files. The job stays active, the checkout stays locked, and `wait` names the `cancel` command.
- **Exit code 124.** Either the job ran longer than 120 minutes and was stopped, or `codex login status` did not answer within 15 seconds and Codex never started. The reason in the output says which.
- **An error inside the Codex runner** after Codex has started, for example a file that cannot be written, stops Codex first. The exit code appears only when Codex has ended, and the checkout stays locked until then.
- **`writer_busy`.** The writer lock refused a `run`. The request file stays, so the same `run` command works again when the other job has ended. When the lock cannot be read, the message names the lock file instead of a job.
- **Codex's own error.** When Codex fails, the reason includes what Codex reported, on a line that starts with `Codex reported:`. For a used-up plan, a line before it tells the main session to send the task to a Claude worker. Codex prints these errors as JSON events, not as error output.

## The data folder

Everything is in `~/.claude/orchestrator/`, or in the folder that `ORCH_DATA_DIR` names:

- The log holds your briefs, so it stays outside the repository.
- The folder has the mode 0700. The files that hold briefs, results or dispatch records have the mode 0600. A folder or a file with a wider mode, from an older version, is tightened on the next write.
- Set `promptLogChars: 0` in `config.json` to keep the text of briefs out of the log. The record then keeps the description and the routing facts.
- Nothing inside a brief is masked. Only the TypeSafe key is.

| File | Content |
| :-- | :-- |
| `dispatch-log.jsonl` | One line per event: `session`, `dispatch`, `launched`, `start`, `stop`, `verification`, `review_findings`, `triage` and `hook_error`. Every line except `hook_error` carries `cwd`, the project folder of the session, so one log serves every project. At 25 MB the file is renamed to `dispatch-log.1.jsonl`, which replaces the older one. So the log takes at most two files of that size. `ORCH_LOG_MAX_BYTES` changes the limit. |
| `writers.jsonl` | A small index of who changed files: the plugin's writer workers, and every Claude `Edit`, `Write`, `MultiEdit` or `NotebookEdit` call, also from the main session. A `PostToolUse` hook on these tools writes one short line per call. The cross-review rule reads this file. |
| `codex-requests/` | The stored tasks for the Codex workers. Removed after 14 days. |
| `codex-jobs/<id>/` | The brief, the events, the error output and the result of each Codex run. Removed after 14 days. `job.json` also says where the job came from and which code it saw, written before the run starts: `origin` (`direct` or `routed`), `request_id`, `session_id` (only when Claude Code passes `CLAUDE_CODE_SESSION_ID`), `head`, `dirty`, `scope_commit`, `base_commit` and `provenance_error`. `exit-code` is written last; an empty one means the job has not ended. |
| `locks/` | One lock per checkout while a writer changes files there. For a Codex job, it names the job and the process that started it. For a Claude writer, it names the session and, once the subagent has started, the subagent. The lock is released when the subagent stops. |
| `codex-limits.json` | The last plan numbers of Codex: percent used, reset time, credit balance. Saved after each Codex job. Numbers that may be older than the saved ones do not replace them. |
| `triage/` | Work files of the finding triage: `pending/` (an accepted hand-back report and the saved stop input), `claimed/` (who works on a report now, with an owner token), `done/` (one result per report; a Codex job's key is `job-<id>`), `skipped/` (Codex jobs that the scan skips permanently: not a review, before the start time, older than 13 days, outside consent, an unreadable `job.json`) and `deferred/` (Codex jobs postponed for an hour; three tries in all). Also `sweep.lock` (the one running job worker), `sweep-since.json` (the start time: jobs that ended earlier are never taken), `sweep-worker.err` (the worker's error output) and `no-key-logged`. All are private to your user. Files older than 30 days are deleted, except `done` files that an evaluation still needs. |
| `labels/` | The finding-triage evaluation: `pools.json` (the tuning and evaluation split, the registered window, scored versions and exposed change groups) and one folder per sample with `items.json`, `answers.json`, `labels.json` and `meta.json` (after the score, `meta.json` also holds the result). All are private to your user. |
| `notices/` | One empty file for each notice that a session has already shown, named by a hash of the session id. Only one hook can create a given file, so parallel dispatches show a notice once. Files older than 14 days are removed. An old `notices.json` is no longer read and can be deleted. |
| `codex-unavailable.json` | Written when a Codex job fails with a usage limit. Until the time in it, the routing sends no tasks to Codex, and the Codex runner starts no Codex job unless `codexSpendCredits` is true. Delete the file to end the pause early. |
| `limits-latest.json`, `limits.jsonl` | Written by the status line snippet: the two percentages, the two reset times (Unix epoch seconds) and the session whose status line saw them. `limits-latest.json` is the newest sample. `limits.jsonl` has one line per change. |

### Log records

| Record | What it holds |
| :-- | :-- |
| `session` | Written at each session start: `source` (`startup`, `resume`, `clear` or `compact`) and the configuration in force. |
| `dispatch` | `claude`: whether Claude counted as near its limit, the reason (`gate` or `pace`) and the projection of each window. `requested`: what the main session asked for. `jev`: the answers, the model version and the time of the call. `route`: what the table said. `final`: what ran. `action` and `reason`: see [Actions in the log](#actions-in-the-log). |
| `stop` | For each of the plugin's workers: `result`, the worker's answer, cut to `resultLogChars`. For a reviewer also: `findings`, a count per priority. |
| `verification` | Jev's label for the checks of a finished worker, or the error of that call. |
| `review_findings` | The `[P0]` to `[P3]` counts of a Codex review, read from the job's own `result.md`. `source` is `codex_result`, or `unavailable` with a `reason` (`no_launched`, `no_request`, `no_job`, `not_finished`, `exit_<code>`, `no_result`, `empty_result`, `unparsed`) and `counts: null`. It is written whatever the triage switches say, because it sends nothing. A Codex review without this line is unknown in the report; the count in its `stop` line comes from the wrapper's summary and is never used. |
| `triage` | A copy of one finding-triage result: the report's source (`codex_job`, `handback`, `final_message`, or `unavailable` with a reason), its parse state, the change group (the git common directory plus the commit), each finding with its citation and Jev's outcome (`supports`, `contradicts`, `insufficient`, `no_citation`, `withheld_secret`, `skipped_budget`, `stale_evidence`, `missing_provenance`, `unverifiable_scope`, `outside_checkout` or `error`), and the evaluation version. A Codex job's result also has `job_id`, `origin`, `scope`, `reviewed_commit` and `attempt`. The full result, with a masked copy of the report, is the file in `triage/done/`, which is the source of truth. |

`model_only: true` marks a dispatch to another agent type that reached the routing table, where the table can name only a model. The mark says that the table read the call, not that the hook changed it. A call with `orch-route: keep` is still marked, because Jev was asked. A call to another agent type that never reached the table has no mark. Its `reason` is one of those in [Calls the hook leaves alone](#calls-the-hook-leaves-alone).

## The report

```bash
node scripts/orch-report.mjs
```

In a session, the same report is `/subagent-router:report`. It reads the whole data folder: `dispatch-log.jsonl`, its rotated file and `limits.jsonl`. It prints counts only. No brief, no description and no worker result reaches the output.

- `--json` prints the same numbers as JSON.
- `--since 2026-09-22` keeps only the records from that time on.
- `--project <text>` keeps only the log records whose project folder contains the text. Records without a project folder are dropped: records from before 2026-09-22 and `hook_error` lines. The Claude usage part is not filtered by project, because usage belongs to the whole account.

What it prints, and what each number is for:

- **Dispatches** per project, mode and action, and the share that the hook changed, by reason. Read this number first. When it is near zero, the TypeSafe calls add delay and cost, and they save nothing.
- **Models that the orchestrator named.** The report calls the main session the orchestrator. It shows how often the main session named a model in the call, and how often the hook ran another one, down or up, by pair (`opus->sonnet`). It also shows how often `shadow` mode would have done so. A move to or from a Codex worker is counted separately, because Haiku only runs the Codex worker and Codex does the task with its own model. Jev sees only the brief, but the main session sees the whole conversation. So when the hook often moves calls to a smaller model, check those calls before you trust the table more than the main session.
- **Jev:** how often it answered, its latency, the kinds, the share of answers at the kind gate and at the difficulty gate, and how often it agreed with the request, named a different route, or named no route (the report prints this last case as "abstained").
- **Signs that a route was too small.** The log already holds these, so they need no extra runs: a retry of the same brief in the same session on a bigger model; a worker whose checks failed or did not run; a Codex job that failed. For the checks, the report uses Jev's answer when the log has one, and a word search otherwise. It says how many results Jev judged. The other direction, a route that was bigger than needed, cannot come from the log. It needs the [offline evaluation](EVALUATION.md).
- **Durations** per worker, from start to stop.
- **Review findings by the family of the author.** The author is the last plugin writer dispatched in the session before the review. A writer that failed or reported "Changed files: none" is not an author. The report reads only the dispatch log, so its author can differ from the one that the cross-review used. It does not count edits by the main session, and it does count a writer that the writer lock denied.
- **Claude usage over time,** from the status line log: the range of each window, how many windows were seen, and for each sample whether it was at the gate, near its limit by pace only (printed as "tight by pace only"), or below both (printed as "calm").

## Finding triage

Two paths do the work.

Review agents other than Codex: the capture hook runs on `PostToolUse` for `SubagentHandback`, without `async`, and only saves an accepted hand-back report to a private file. A synchronous hook ends before the subagent stops, so the report is on disk when the triage starts. The triage hook runs on `SubagentStop` with `async: true`, so the session never waits for it. For a `codex-reviewer` stop it only writes the `review_findings` count and starts the job worker.

Codex review jobs, whoever started them, go another way.

- **The launcher** runs on `Stop` (the end of each turn) and `SessionStart`, without `async`, with a 5-second limit. It is one short Node process; it prints nothing on its output, and settings warnings go to its error output. While the triage is on in the shared settings file, it publishes the start time (`triage/sweep-since.json`); while it is off there, or no project may send, it removes it, so a job that ended then is never sent later. The end of every Codex job removes it too while the triage is off in the shared settings file (the runner just before it writes `exit-code`, and `orch-codex.mjs cancel` before it writes exit code 130), so this holds also when no launcher ran before the triage was switched on again. A switch for one session only (`ORCH_MODE`, `ORCH_JEV_ENABLED`) never moves the start time. `orch-codex.mjs` also publishes it when a review starts. The launcher starts the job worker only when a finished job waits, no worker runs and the key is present; without the key it logs that once a day.
- **The job worker** is a detached process: it does not belong to the session, so the end of a session does not stop it. It gets the key through a pipe, never through its environment, because it runs git in every job's checkout, and a program that a repository's settings make git run can read its parent's environment. Its environment holds the shared settings only, so one session's switches (for example `ORCH_TYPESAFE_URL`) never decide for the jobs of other sessions. It scans `codex-jobs/` and takes each finished `kind: review` job once, oldest first, at most 25 jobs or 10 minutes per run. It uses the same consent, redaction and record rules as the hook.
- **Evidence:** an excerpt is sent only when its bytes provably equal the reviewed code, and never from a file that holds a private key (see step 4 below). Only a commit review allows that proof: the bytes must have the git blob id (git's id for exactly those bytes) of the reviewed commit's file. Base, uncommitted and custom reviews give `unverifiable_scope` and send nothing, because Codex compares them with the working tree, which can change in ways no later check reveals. A cited path through a symbolic link, in another letter case, or in a nested repository is never sent.
- **Exactly once:** a claim and the worker lock hold an owner token, a random value that only their owner knows. A result is published once, by an exclusive link, so a worker that was suspended and lost its claim never overwrites one.
- **Later tries:** a missing checkout, consent that git could not decide (also in the last check before the send), and a Jev outage or rate limit postpone the job (`triage/deferred/`): the first launcher run after an hour tries again. After the third try in all, a missing checkout or an undecided consent at the first check marks the job as skipped. An undecided consent in the last check before the send, and a Jev outage, end the job with a `done` record that keeps the error (`consent_unknown`, or the Jev error). A worker that lost its lock only releases its claim; the lock's owner does the job. A running worker stops when the start time changes. Without a key the worker claims nothing, so a keyless session never marks a job as done.
- **Limits:** a job that no scan reaches within 13 days is lost when `orch-codex.mjs` prunes its folder. Git runs without any `GIT_` variable and without the key, because a repository's own settings can make git run a program.

For each finished review the triage:

1. picks the report: the Codex job's `result.md` (only with `exit-code` 0 and some text), else the captured hand-back, else the last assistant message. In auto mode it waits up to 30 seconds for a late capture and marks `handback_missing` when none comes;
2. checks consent: `jevEnabled`, a mode other than `off`, `triageMode: "log"`, and the session's checkout root exactly in `triageProjects`, or, with `triageWorktrees`, a worktree of a listed checkout's repository (the same git common directory, the shared `.git` folder, and a folder that git lists as a worktree). Git runs without any inherited `GIT_` variable, so such a variable cannot make another folder look like a listed repository. It reads the settings again right before each send;
3. splits the report into findings with the `[P0]` to `[P3]` parser or a `reviewFormats` entry. A report ends as `parsed`, `partial`, `empty`, `unparsed` or `unavailable`. A report without a `[P*]` tag is `empty` only when it is one short paragraph that opens with a complete clean verdict, such as "No actionable regressions found in commit abc.": one paragraph of at most 600 characters, no list item, no `path:line`, no qualifier other than "actionable" or "discrete", and no word such as "but" or "apart from". Any other untagged report is `unparsed`. Known limit: a defect written as a plain sentence after a complete verdict, with no qualifier, no `path:line` and no such word, is read as `empty`;
4. reads the cited code: only regular files inside the git root, opened without following links and checked again on the open file. A citation of a file with a common credential name (such as `.env`, `prod.env`, `.npmrc`, `secrets.yml`, `serviceAccount.json`, `*.pem`, `*.p8`, `*.ppk` or anything under `.ssh`; by its written path or its real path, also when the file does not exist) is never read and holds the whole finding back as `withheld_secret`, before any file is read. A file with a NUL byte anywhere (binary, or UTF-16) is not read. For a review agent's report, never a file that git ignores; when git cannot answer, the file is not read either, and one line on stderr names the failure. A new file that git does not ignore is read, because a review of uncommitted work cites such files. When a cited file holds the first or the last line of a private key anywhere (PEM, PGP, SSH2 or PuTTY, also in base64), the whole finding is `withheld_secret`, also when another citation could be read: the excerpt is only a window of the file, and a window inside the key may hold neither line;
5. masks secrets, then cuts, and sends at most 12 findings in one request. Each cited file is masked whole before its window is cut and numbered, so a value on the line after its name is masked too; the finding text is masked whole before it is cut. The citations are found in the finding's own text, and only the masked text is sent. Masked are known token shapes, the password in a URL (`scheme://user:<password>@host`), the credential of an `Authorization` header (Bearer, Basic, Token), and secret-like assignments: a name that holds a word such as password, passphrase, secret, token, api key, private key or credentials, then `:`, `=` or `:=`, with an optional type annotation (`api_key: str =`, `apiKey: string =`); the value is masked, and so is the type, because in YAML or prose such as `password: <secret> = x` the secret stands where a type would stand, and a harmless name such as `max_tokens` is masked too. Masking stays best effort. Not caught: a PHP-style `'api_key' => 'x'`; a text that quotes only the body lines of a key; a name without one of the words (`DB_PASS`, `PWD`); a name that goes on with a dot after the word (`app.secret.key=`, `api.key=`); a name with more than 100 characters on one side of the word; a default value (`|| "x"`, `getenv("K", "x")`); a YAML block scalar, a value split over lines, an unquoted value that holds `;`; and XML key and value pairs;
6. writes the `done` file first and the log line after it. A crash between the two loses nothing, and a stopped run is redone by a later one.

`orch-label.mjs` evaluates the judgements on data you label yourself. `reserve` splits change groups into tuning and evaluation by a hash rule. `register` freezes a window, the evaluation version and the population. A date without a time means 00:00 UTC of that date: `--end 2026-10-24` ends the window when October 24 begins, so reviews from that day are not in it. Pass the next day to include it. `sample` draws one finding per change group after the window ends, without Jev's answers, plus up to 20 precision items (findings that Jev called "contradicts") and 20 whole reports. The findings and the precision items are shown in one shuffled order, so their position does not tell them apart; the same seed gives the same sample. `score` checks the bar once, and saves the result in `meta.json` before it marks the version as scored in `pools.json`; when that second write fails, the next `score` finishes with the saved result and never evaluates again. The bar: harm (Jev calls a supported finding "contradicts": the 95 percent upper bound must be at most 10 percent, with at least 29 supported findings), use (at least half of at least 8 contradicted findings found), coverage (at least half answered "supports" or "contradicts") and parsing (at least 80 percent of 20 reports extracted completely). `status` shows progress; from day 7 of the window, fewer than 15 eligible change groups print `TRIPWIRE`. While a window is registered and `triageMode` is `log`, the session start shows the same line once per UTC day, for all sessions together, as a notice and in the model's context. Before the start it names the start date. After the end it says to draw the sample, or, once a sample of this version exists, to label and score it; no day count and no `TRIPWIRE` then. Once the version is scored, the line stops, and `status` says that the window was scored.
