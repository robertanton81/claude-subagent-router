# The report and the log

Part of the [Subagent Router documentation](../README.md#documentation). The `node scripts/...` commands on this page run from a clone of this repository.

## Why was a call not rerouted?

The common causes, with the `reason` that the log shows:

- Jev is off, which is the default: `jev_disabled`.
- The hook found no key: `error_no_key`.
- Jev was not sure of the kind of task: `low_confidence`.
- The agent type is on `keepModelAgents`: `keep_model_agent`.
- The table picked what the call already had: the action is `agree`.

This command prints the last five dispatches from the log: the time, the agent and model that the main session asked for, the agent and model after routing, the action and the reason. A model is `null` when the call named none; the model of the agent file then ran. For the action `deny`, nothing ran. The command prints no brief.

```bash
node -e '
const fs = require("fs"), path = require("path"), os = require("os");
const file = path.join(process.env.ORCH_DATA_DIR || path.join(os.homedir(), ".claude/orchestrator"), "dispatch-log.jsonl");
if (!fs.existsSync(file)) { console.log("no dispatch log yet"); process.exit(0); }
const records = fs.readFileSync(file, "utf8").trim().split("\n").slice(-500).map((line) => JSON.parse(line));
for (const r of records.filter((r) => r.event === "dispatch").slice(-5)) {
  console.log(r.ts, r.requested?.agent, r.requested?.model, "->", r.final?.agent, r.final?.model, r.action, r.reason);
}'
```

Every action and reason is explained in [Actions in the log](#actions-in-the-log) and [Calls the hook leaves alone](routing.md#calls-the-hook-leaves-alone).

## Actions in the log

Each `dispatch` record has an `action`:

| `action` | Meaning |
| :-- | :-- |
| `rewrite` | The hook changed the agent type, the model, or both. |
| `agree` | The table picked what the call already had. |
| `pass` | The hook did not route the call. The `reason` says why; see [Calls the hook leaves alone](routing.md#calls-the-hook-leaves-alone). |
| `shadow` | `shadow` mode: the log shows the route that the hook would take, and the call runs unchanged. |
| `redirect` | The hook sent a call to `codex:codex-rescue` to `subagent-router:codex-implementer`. |
| `fallback` | Codex cannot take work, so the hook moved a task for a Codex worker to its Claude counterpart. |
| `deny` | The writer lock refused the call. |

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
- **Signs that a route was too small.** The log already holds these, so they need no extra runs: a retry of the same brief in the same session on a bigger model; a worker whose checks failed or did not run; a Codex job that failed. For the checks, the report uses Jev's answer when the log has one, and a word search otherwise. It says how many results Jev judged. The other direction, a route that was bigger than needed, cannot come from the log. It needs the [offline evaluation](../EVALUATION.md).
- **Durations** per worker, from start to stop.
- **Review findings by the family of the author.** The author is the last plugin writer dispatched in the session before the review. A writer that failed or reported "Changed files: none" is not an author. The report reads only the dispatch log, so its author can differ from the one that the cross-review used. It does not count edits by the main session, and it does count a writer that the writer lock denied.
- **Claude usage over time,** from the status line log: the range of each window, how many windows were seen, and for each sample whether it was at the gate, near its limit by pace only (printed as "tight by pace only"), or below both (printed as "calm").

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

`model_only: true` marks a dispatch to another agent type that reached the routing table, where the table can name only a model. The mark says that the table read the call, not that the hook changed it. A call with `orch-route: keep` is still marked, because Jev was asked. A call to another agent type that never reached the table has no mark. Its `reason` is one of those in [Calls the hook leaves alone](routing.md#calls-the-hook-leaves-alone).
