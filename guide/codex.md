# Codex

Part of the [Subagent Router documentation](../README.md#documentation). The `node scripts/...` commands on this page run from a clone of this repository.

The Codex CLI runs coding tasks on your ChatGPT plan. The plugin can send implement tasks and reviews to it, and you can ask it questions by hand. To turn it on, see [Setup](setup.md#turn-on-codex-optional).

**While Codex is off:**

- The routing table sends no task to Codex. Reviews go to `subagent-router:reviewer`.
- In `enforce` mode, a direct call to a Codex worker runs on a Claude worker.
- The Codex runner, the plugin's script that starts and watches Codex jobs, starts no job in any mode. It does not even run `codex login status`.
- A call to `codex:codex-rescue` passes unchanged. That agent belongs to OpenAI's separate Codex plugin for Claude Code.
- The setup check reports `Codex: off` and skips the Codex CLI checks.

**The `codex:codex-rescue` redirect.** OpenAI's Codex plugin has an agent `codex:codex-rescue` that describes itself as one to use proactively, so the main session may pick it on its own. That agent starts Codex outside this plugin, so the writer lock and the credit checks do not apply to it. So while Codex is on, in `enforce` mode, the hook sends a call to `codex:codex-rescue` to `subagent-router:codex-implementer`. It does this also when the brief has `orch-route: keep`. This blocks one known way to skip the routing, but other ways still exist. It also means that `/codex:rescue` runs the plugin's Codex implementer. To use OpenAI's agent, start the session with `ORCH_MODE=off`. This turns off all routing for that session.

## Credits and pauses

When a Codex plan window, the 5-hour or the weekly one, reaches 100 percent, Codex does not stop. It goes on and spends your bought credits. The plugin blocks that by default:

- **The plan is used up.** While the saved plan numbers show a window at 100 percent, the plugin starts no Codex job. This ends at the reset time in those numbers. No new job can start during the block, so no newer numbers can end it earlier. Saved numbers that have no reset time do not end by themselves.
- **A job failed with a usage limit.** The plugin then starts no Codex job until the time that Codex named in its error. When the plugin cannot read a usable time there, the pause lasts one hour. It writes the end time to `~/.claude/orchestrator/codex-unavailable.json`. Delete that file to end the pause early. This does not end the block of a used-up plan.
- **Credits allowed.** With `"codexSpendCredits": true`, the Codex runner also starts jobs when the plan is used up or paused. In `enforce` mode, the routing hook still sends Codex tasks to Claude during a pause. So during a pause, only a job that you start by hand, such as `consult`, or a call in `shadow` or `off` mode, can spend credits.
- After each job, the `CODEX_JOB` line shows `codex_used=<percent>`. A run that was paid from credits says so, with the balance.

## Codex plan numbers

The plugin learns the plan numbers only after a Codex job that it started. So between two jobs the numbers can be out of date. The numbers come from Codex's own session file, where Codex records each run. For a scoped review (`codex exec review`), Codex runs the review in a child thread and writes the numbers only into that thread's file. The plugin finds that file by the `parent_thread_id` field on its first line. The format of these files, this field included, is internal to Codex and not a public interface, so a Codex update can change it. When the plugin cannot read the numbers, the plan counts as unknown.

## How a task reaches Codex

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

## Instruction snapshot

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

## Codex reviews

A brief line `review-scope:` picks the kind of review; see [Lines that a brief can carry](routing.md#lines-that-a-brief-can-carry).

- **A scoped review** (`uncommitted`, `base:<branch>` or `commit:<hash>`) uses Codex's own review rules. Codex refuses review instructions together with a scope flag, so a scoped review does not read the brief.
- **A custom review** sends the brief to Codex as the review instructions. It runs as a plain `codex exec` in the `read-only` sandbox. It does not use `codex exec review`, because that command returns only a short JSON verdict, and a longer answer would be lost. So Codex's final message comes back whole.

The Codex runner adds a short contract to a custom review brief:

- The task is read-only.
- The final message must hold the whole answer.
- The answer format of the brief wins.
- Each new finding gets a priority tag from `[P0]` to `[P3]` by the harm it causes, which the report counts. A finding that the brief lists as known goes under `Known:`, without a tag.

Codex sometimes writes its long answer in an earlier message and ends with a short line. The result then shows that earlier message too, with a label. A message counts when it is at least 1,000 characters long and longer than the final message.

When the routing hook moves a review from `subagent-router:reviewer` to Codex and the brief names no scope, the request gets the scope `custom`. So the brief travels as the review instructions, and none of it is lost. The dispatch record shows the scope in `review_scope`. The request file says in `scope_source` whether the scope came from the brief, from the routing or from the default.

## Ask Codex a question

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

## Long Codex runs and failures

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
