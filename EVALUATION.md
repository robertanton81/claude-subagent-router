# Offline evaluation

The dispatch log shows where the routing hook changed a route. It cannot show whether the other route would have been better, because only the chosen subagent ran. To answer that, the same task must run in several setups, called arms. The evaluation runner does this: it runs each task in each arm, grades each result and saves the numbers. Offline means separate from your real work: the runner starts its own Claude Code sessions on test tasks.

The words dispatch log, routing hook, subagent, main session, Jev, the modes and the limit rules are explained in the [README](README.md), [How the routing works](guide/routing.md) and [When a plan is near its limit](guide/usage-limits.md). In this file, the worker is the Claude Code session that the runner starts for one run, not one of the plugin's workers.

Every run counts against your Claude plan. Before it starts, the runner prints the list of runs and the most they can cost. `--dry-run` stops there.

The commands in this file run from a clone of this repository.

## Run it

```bash
node scripts/orch-eval.mjs <task set.json> --dry-run
```

```bash
node scripts/orch-eval.mjs <task set.json> --arms off,sonnet,shadow,jev --runs 3 --max-total-usd 5
```

`examples/eval-tasks.json` is a sample. Its `cwd` is `/tmp/orch-live-check`, a scratch project that does not ship with the plugin. The runner checks every `cwd` before it prints the list of runs. So even `--dry-run` stops with "the folder ... does not exist" until `cwd` names a folder on your machine. Copy the file, set `cwd` to one of your projects, and change the prompt and the expectations to fit that project.

## Task sets

A task set is a JSON file with a `tasks` list. Each task must set its own `name`, `prompt` and `cwd`. The file may also set defaults for all its tasks: `model`, `budgetUsd`, `timeoutS`, `allowedTools`, `export`, `history`, `expect`, `expectRoute`, `verify` and `trace`.

| Field | Meaning | Default |
| :-- | :-- | :-- |
| `name` | The name of the task: letters, digits, dots, dashes or underscores, at most 64 characters. | required |
| `prompt` | What the main session is asked to do. | required |
| `cwd` | The project folder, absolute or relative to the task-set file. | required |
| `model` | The model of the main session. | `sonnet` |
| `budgetUsd` | The cost cap of one run. It reaches Claude rounded to whole cents, so it must be at least 0.01. | 1 |
| `timeoutS` | The time limit of one run, in seconds. | 600 |
| `allowedTools` | The tools the main session may use. | `Read`, `Glob`, `Grep`, `Agent` |
| `export` | Run in a fresh copy of the last commit. Use it for a task that writes files. | off |
| `history` | With `export`, the copy keeps the git history up to the last commit, without a remote. Use it for a review task that needs a base commit and a change commit. | off |
| `expect` | The text grader. See [Graders](#graders). | none |
| `expectRoute` | The route grader. See [Graders](#graders). | none |
| `verify` | The executable grader. See [Executable graders](#executable-graders). | none |
| `trace` | The run prints one line per message (`--output-format stream-json`), and its record gets a `trace` field: how often each tool was called, which skills were loaded and which agents were started. Each skill and agent entry has `main`, which is false for a call that a subagent made. The field is `null` when the output holds no message line, which is not the same as a run with no tool call. Use it when a result depends on which skill a session loaded. | off |

## Graders

A run passes when every grader that applies to it passes.

- **`expect`** has two lists, `contains` and `notContains`: strings that the answer must contain, and strings that it must not contain.
- **`expectRoute`** holds `agent`, `model` or both: the expected route. It may also hold `min`, the fewest dispatches (subagent calls) that the run must make, 1 by default. Every dispatch of the run must take the expected route, and a run with fewer than `min` dispatches fails. Only the `jev` arm is graded by `expectRoute`, because it is the only arm in `enforce` mode.
- **`verify`** names an executable grader. See [Executable graders](#executable-graders).

For a task without `verify`, a run that errors or times out is not graded. For a task with `verify`, such a run counts as a failure, also when the worker crashes.

You can change the text expectations and apply them to saved records without another model call:

```bash
node scripts/orch-eval.mjs <task set.json> --regrade ~/.claude/orchestrator/eval/<time>/
```

`--regrade` does not run an executable grader again. It checks the saved [evidence](#evidence) against the saved workspace, the copy of the project that the run worked in (see [Workspace and sandbox](#workspace-and-sandbox)), and against the original grader. A changed executable grader needs a fresh run.

## Arms

| Arm | Setup |
| :-- | :-- |
| `off` | Claude Code without the plugin. |
| `sonnet` | Without the plugin, with every subagent forced to Sonnet. The pass rule compares the `jev` arm with this arm. |
| `shadow` | The plugin in `shadow` mode. Its workers and skills exist, and the hook changes nothing. |
| `jev` | The plugin in `enforce` mode. |
| `low`, `medium` | Without the plugin, with the whole session at that effort. These run only when `--arms` names them. |

- Effort is how much the model thinks before it answers. `low` and `medium` are the single-model baselines. Anthropic measured that one model at a lower effort often costs less than a setup with several models.
- The shell's `CLAUDE_CODE_EFFORT_LEVEL` and `CLAUDE_EFFORT` never reach an arm. So each arm runs at the effort it names, or at the default of its model.
- Other session variables from your shell do reach the plugin arms, for example `ORCH_CODEX_ENABLED`, `ORCH_COMPLETE_RULE`, `ORCH_ROUTE_OTHER_AGENTS`, `ORCH_JEV_TIMEOUT_MS` and `ORCH_TYPESAFE_URL`. They win over the defaults and over the `--config` file. Unset them before a run.
- Each run gets its own data folder inside the results folder, which is `~/.claude/orchestrator/eval/<time>/` by default, or a temporary folder for a task set with an editing task (see [Results](#results)). So the runs leave the log, the locks, the settings file and the other state files in your real `~/.claude/orchestrator/` alone. A run has no usage sample, so the limit rules, the pace rule included, are off.
- `--config <file>` gives the plugin arms a copy of a config file. Without it, the defaults apply, with Codex off.
- The `shadow` and `jev` arms turn Jev on for themselves. They read the key from `TYPESAFE_API_KEY` in the shell that starts the runner.
- The prompt cache keeps the start of a prompt, so that the next call can reuse it at a lower price. The first run in a round finds an empty cache and pays more. Each round starts with a different arm, so this extra cost does not always fall on the same arm.

## The pass rule

At the end, the runner gives each task a verdict: `PASS`, `FAIL` or `NOT DECIDED`. It compares the `jev` arm with the `sonnet` baseline in a fixed order: accuracy, then tokens, then time. A later step counts only when the earlier one did not decide.

**Accuracy** is the pass rate of the answer and executable graders. The route grader is a separate check, because only the `jev` arm gets it. **Tokens** are input, output and cache writes over all models, with no price weight. Cache reads stay out, because they count the same context again on each turn. **Time** is the clock time of the whole run, so the delay of the hook and of Jev counts.

**1. The verdict is `NOT DECIDED` when:**

- the run lacks the `jev` arm or the `sonnet` arm;
- an arm has fewer than three graded runs. In a task without `verify`, a run that errored, timed out or was cut off is not graded. In a task with `verify`, every run is graded: a run that errored or timed out counts as a failure, and a cut-off answer fails when the task also has `expect`;
- no answer grader ran, so there is no accuracy. A task whose only grader is `expectRoute` always ends here. Add `expect` or `verify` to get a verdict.

**2. Accuracy decides when it can.** Three to five runs cannot show that two arms are equal: 3 of 3 passes still has a 95 percent range of about 44 to 100 percent. So this step is one-sided.

- The verdict is `FAIL` when the `jev` arm has a lower accuracy, when a route was not the expected one, or when the `jev` arm errored or timed out in a larger share of its runs.
- The verdict is `NOT DECIDED` when none of these failures was seen and neither arm answered right, so nothing can favour one of them.
- The verdict is `PASS` when the `jev` arm is clearly more accurate: the 95 percent Wilson ranges of the two arms do not overlap. So 5 of 5 against 0 of 5 wins, and 3 of 3 against 0 of 3 does not. This is how a correct move to a larger model can pass, whatever it costs.
- Otherwise the runner prints both ranges and goes on. A later `PASS` then means "no loss seen", not "equally accurate".

**3. Tokens, then time.** Each compares the means of the two arms. Both use the same margin, fixed in advance: 10 percent of the baseline.

- A gap wider than the margin and wider than the uncertainty of the gap (twice its standard error) is a real difference. Fewer tokens or less time gives `PASS`. More gives `FAIL`, or `NOT DECIDED` when the `jev` arm had a higher accuracy that was no clear win.
- When the whole gap, with its uncertainty, stays inside the margin, the two arms count as the same, and the next step decides. Same tokens and same time end `NOT DECIDED`.
- Anything else is noise, and the verdict is `NOT DECIDED`. Time does not decide in place of tokens that are unclear.

**Tokens also end `NOT DECIDED` when** fewer than three runs of an arm reported them, or when the two arms wrote very different amounts into the prompt cache (a factor above two). The same run count holds for time: when the tokens are the same and fewer than three runs of an arm reported a time, the verdict is `NOT DECIDED` and says so. Neither guard hides an accuracy result.

The cost in dollars stays in the summary, but it is not part of the verdict. The goal is the most relevant model for a task, and a rule that passes the cheaper arm cannot pass a correct move to a larger model.

When `low` or `medium` ran next to `jev`, the summary also compares the cost of `jev` with each of them, under the run-count and cache guards above. This comparison is not part of the pass rule. It tells you whether a plain session at a lower effort reaches the same pass rate for less money than the routing.

Read the column "cache new" before the cost. A run that wrote many tokens into the prompt cache costs more for that reason alone, whatever the route did.

## Results

The results go to `~/.claude/orchestrator/eval/<time>/`, or to the folder that `--out` names.

A task set with an editing task (`export: true`) is different. Each such run works in a copy inside the results folder, and Claude Code denies every write inside a protected folder in `dontAsk` mode, whatever the allow rules say. `.claude` is protected (except `.claude/worktrees`), as are `.git`, the plugin folder and a few others; see "Protected paths" on Claude Code's permission-modes page. So:

- Without `--out`, the results go to `<temporary folder>/orchestrator-eval/<time>/`. The system may clean that folder up, so pass `--out` with a lasting folder to keep the evidence.
- An `--out` folder inside a protected folder is refused before any run starts, also through a symbolic link.

- `runs.jsonl` has one line per run: the cost, the turns, the durations, the models that ran, the number of refused tool calls, the dispatches of the plugin's hook with the model that then ran, and the answer cut to `--result-chars`. Executable tasks add their evidence and `source_revision`.
- A failed or timed-out run also keeps the last 2,000 characters of its error output in `runs.jsonl`. This text is not redacted, so treat the file as private output of the run.
- `summary.json` has the counts per task and arm.
- The text summary prints counts only. No prompt and no answer reaches it.

Exit codes:

| Code | Meaning |
| :-- | :-- |
| 0 | Every run finished, and every executable grader passed. A `FAIL` verdict still gives 0. |
| 1 | An error or a timeout in some run, a failed executable evaluation, or an error of the runner itself, for example a missing sandbox or a results folder that is not empty. |
| 2 | The arguments or the task set are not valid, for example a `cwd` that does not exist. Nothing was started. |
| 3 | `--max-total-usd` stopped the command. The limit is checked between two runs. A run that reported no cost, for example after a timeout, counts at its own `budgetUsd`, in the whole cents that the run got as its cap. |

## Executable graders

For a task that edits code, an executable grader can check the result. Set `export: true` and add `verify` to the task:

```json
"verify": { "script": "../checks/check.mjs", "timeoutS": 30 }
```

- The script path is relative to the task-set file. It must be outside the source folder that `cwd` names.
- Trust a task set and its graders only as much as code that you run yourself. Never run a grader that came from an issue or from the worker.
- The runner copies the single `.mjs` grader before it starts the worker. Sibling helper files are not copied, so use Node's built-in modules only.
- The grader's only argument is the path of the snapshot: a copy of the workspace after the run.
- Exit code 0 means pass. Another exit code, or a timeout, means failure.
- The grader should check the required behavior itself. If it runs the code that the worker wrote, run that code in a child process and check the result in the grader. If the grader imports that code, the code can stop the grader or change it.

### Workspace and sandbox

Three folders take part:

- The **source folder** is the folder that `cwd` names. It must be inside a git repository. The runner leaves it untouched.
- The **workspace** is a fresh copy of the source folder at its last commit. The worker runs there. Each task uses one pinned commit across all arms and runs, and the records include it as `source_revision`.
- The **snapshot** is a protected copy of the workspace after the run. The grader reads it.

A task with `verify` needs an empty results folder.

The worker runs inside a sandbox of the operating system:

- On macOS, the whole worker runs under Seatbelt, the sandbox built into macOS, through `/usr/bin/sandbox-exec`.
- On Linux, it needs a working bubblewrap installation at `/usr/bin/bwrap` or `/bin/bwrap`. The runner installs nothing.
- Other operating systems cannot run executable evaluations yet.
- A missing or unusable sandbox stops the run before the worker starts. The runner never falls back to a process without limits.

On Ubuntu 24.04, installing bubblewrap alone may not let it create user namespaces, the Linux feature that bubblewrap uses to isolate a process. An administrator must also install `apparmor-profiles` and load its `bwrap-userns-restrict` profile. Check the existing AppArmor profiles before you add another profile for the same program. This repository's CI (the automatic tests on GitHub) installs that Ubuntu profile on its short-lived test machine. It checks that user namespaces work before it tests the sandbox. See [Ubuntu's explanation of per-application namespace permissions](https://ubuntu.com/blog/ubuntu-23-10-restricted-unprivileged-user-namespaces).

What the worker and the grader can reach, and how snapshots are made:

- **The worker** can write only its workspace, the router data folder and its private temporary folder. It cannot read the copied grader, the folders under `<output>/verification/` with the earlier and later runs, or any original grader of the task set. It can read other files and use the network, because Claude Code needs them to reach Anthropic and to run project tools. So the worker can still send out anything that it can read. The sandbox also does not hide other copies of the graders or the git history elsewhere on the host.
- **The grader** has no network, gets no inherited credentials, and can write only its own temporary folder. It reads the snapshot, the grader and the runtime files.
- **Snapshots** reject links and special files. The runner refuses a snapshot above 100 MiB or 10,000 entries. The copy also runs inside a sandbox. So even if the worker swaps a file for a link during the copy, the runner cannot read other files on the host.

Run `npm run test:boundaries` on a host that supports the sandbox. It needs a working sandbox, and it fails when the sandbox cannot start. CI runs it on macOS and Linux. On hosts where a sandbox cannot start inside another sandbox, `npm test` checks that the runner refuses to run.

### Evidence

The runner saves the grading files of each run under `<output>/verification/grade-*/`, and `runs.jsonl` includes the evidence:

- the grader hash, the code hash, the command, the exit code, the duration, the timeout and the sandbox backend;
- the grader's output as a hash only, so that no secret in it is kept;
- a status: `passed`, `failed`, `stale` or `error`.

A worker's claim that the tests passed cannot replace this evidence. The hashes identify content. They are not signatures, so they do not protect against someone who can edit the result files outside the worker.

`--regrade` checks the current workspace and grader against the saved hashes. Missing, changed or unavailable evidence cannot pass. Keep the saved workspace if you want to check the results again. Regrading reports grade failures in its summary; its exit code 0 means that the records were read.

An evaluation without `verify` does not use this sandbox. Its worker runs like a normal Claude Code session.
