# Claude Subagent Router

A Claude Code plugin that picks the model for each subagent task. A subagent is a helper that your main Claude Code session starts for one task. The main session gives it a brief: the prompt that describes the task. The plugin sends each task to the smallest Claude model that can do it. It can also move work to the Codex CLI, OpenAI's coding agent for the terminal.

To pick a model, the plugin asks Jev about each brief. Jev is a paid classifier from TypeSafe: a model that writes no text and answers fixed questions with probabilities. Jev is off until you turn it on, and while it is off, the plugin picks no model. See [What leaves your machine](#what-leaves-your-machine).

**Contents:** [Why](#why) · [Requirements](#requirements) · [Install](#install) · [Setup](#setup) · [What leaves your machine](#what-leaves-your-machine) · [How it works](#how-it-works) · [TypeSafe and Jev](#typesafe-and-jev) · [Codex](#codex) · [Use](#use) · [Why was a call not rerouted?](#why-was-a-call-not-rerouted) · [Configuration](#configuration) · [Known limits](#known-limits) · [More documentation](#more-documentation) · [Develop the plugin](#develop-the-plugin)

## Why

Your Claude plan counts usage in two windows, periods that start again when they reset: a 5-hour window and a weekly window. Without routing, a subagent often runs on the same large model as the main session, even for a simple file search. That uses up both windows faster than needed.

The plugin reads each brief before the subagent starts and picks a model that fits the task:

- Haiku for a search.
- Sonnet for most edits and reviews.
- Opus for hard work.
- Codex, if you turn it on. A hard implementation task goes to Codex when its brief is self-contained: the brief holds everything that the task needs, so Codex needs nothing from the conversation. When Claude is near its limit, more tasks move to Codex. So your ChatGPT plan takes part of the work. A review can then go to the other model family: Codex reviews what Claude wrote, and Claude reviews what Codex wrote.

The plugin calls no Claude or OpenAI API, so the work stays inside your plans. Codex can spend credits that you buy on top of your ChatGPT plan. The plugin blocks that unless you allow it, with one exception in [Known limits](#known-limits). The one paid API is Jev, at about $0.00005 per call.

Whether the routing saves money on your work is not proven for you yet. The [offline evaluation](EVALUATION.md) measures it.

## Requirements

- Claude Code with a Claude plan.
- Node.js 20 or newer. The plugin has no npm dependencies.
- For the routing: a TypeSafe API key for Jev.
- Optional: the Codex CLI with a ChatGPT login, to send work to Codex. Codex jobs need macOS or Linux. On Windows, the routing between Claude models works, and Codex stays off.

## Install

This repository is also a marketplace: a catalog of plugins that Claude Code can install from. The file `.claude-plugin/marketplace.json` defines it. Add the marketplace once:

```bash
claude plugin marketplace add robertanton81/claude-subagent-router
```

Then install the plugin for one project:

```bash
cd /path/to/your-project && claude plugin install subagent-router@claude-subagent-router --scope local
```

- `--scope local` turns the plugin on only in that project. It writes this setting to `.claude/settings.local.json`, which Git does not track.
- Leave out `--scope` to turn the plugin on in every project.
- `--scope` decides where the plugin is on. The settings file, `~/.claude/orchestrator/config.json`, is one file per user. It applies in every project where the plugin is on.
- If you already have a TypeSafe key, the command in [Turn on Jev](#turn-on-jev) installs the plugin and stores the key in one step.
- `claude plugin marketplace update claude-subagent-router` fetches a new version.
- If you still have the old `orchestrator@llm-orchestrator`, follow the steps under 0.3.0 in [CHANGELOG.md](CHANGELOG.md) first.

Until you turn Jev on, the plugin sends nothing to TypeSafe and picks no model. [While Jev is off](#while-jev-is-off) lists what still works.

## Setup

Do the steps in this order. Each optional step adds one feature.

If you installed from the marketplace, use the skills in a session: `/subagent-router:configure`, `/subagent-router:setup` and `/subagent-router:report`. The `node scripts/...` commands in this README do the same work, but they run from a clone of this repository: `git clone https://github.com/robertanton81/claude-subagent-router`.

### Turn on Jev

1. Create a key in the TypeSafe console: https://console.typesafe.ai/keys.
2. Store the key in the plugin option. A plugin option is a setting that Claude Code keeps for the plugin and passes only to the plugin's hooks. A hook is a script that Claude Code runs at a fixed event, for example before each subagent call. Copy the key, then run this in a terminal, in the project folder:

   ```bash
   k=$(pbpaste) && claude plugin install subagent-router@claude-subagent-router --scope local --config "typesafe_api_key=$k"; unset k; pbcopy </dev/null
   ```

   - Use the same `--scope` as your install. For an install in every project, leave out `--scope local`.
   - `pbpaste` reads the key from the clipboard. So the key is never typed, printed or kept in the shell history. `pbcopy </dev/null` clears the clipboard. On Linux, use `xclip -o -selection clipboard` or `wl-paste` instead of `pbpaste`.
   - The command also works when the plugin is already installed. It keeps the install and sets the option.
   - Claude Code keeps a sensitive option in the macOS Keychain, or in `~/.claude/.credentials.json` on other systems. The Claude Code docs say that Claude Code can also ask for the option when you enable the plugin. That path was not tested here.
   - The variable `TYPESAFE_API_KEY` works too, for example for scripts, CI, the evaluation runner, or on Windows. Set it in the environment that starts Claude Code.
   - No other place is read: no key file in your home folder, and never a `.env` file in a project. A cloned repository could ship its own key there and then receive your briefs in its own TypeSafe account.
3. Run `/subagent-router:configure` in a session and turn Jev on. Or run `node scripts/orch-config.mjs set jevEnabled=true`. A key alone does not turn Jev on. For one session, `ORCH_JEV_ENABLED=1` or `0` overrides the settings file.
4. Start a new session and ask for a task that uses a subagent, for example: "Use a subagent to list the files that import the module `fs`." Then run `/subagent-router:setup`. Its row "TypeSafe key" should say that the hook found the key in the plugin option.

### Turn on Codex (optional)

Codex stays off until you turn it on.

1. Install the Codex CLI and run `codex login` with your ChatGPT account.
2. Turn Codex on with `/subagent-router:configure`, or with `node scripts/orch-config.mjs set codexEnabled=true`. For one session, start Claude Code with `ORCH_CODEX_ENABLED=1`. The variable wins over the settings file, so `ORCH_CODEX_ENABLED=0` turns Codex off for one session.
3. Optional: the plugin has two Codex workers, small subagents that start Codex; see [The workers](#the-workers). Each one calls `scripts/orch-codex.mjs` with Bash: `run` once, then `wait` up to 6 times while the job still runs. To avoid a permission question each time, allow the script in your settings: `Bash(node */scripts/orch-codex.mjs *)`. The first `*` matches any folder, so this also allows a script with the same name in any other clone.

### Add the status line log (optional)

The limit rules move work to Codex, or cap models at Sonnet, when Claude is near its limit. The status line is the line at the bottom of Claude Code that a script of yours prints. Only that script receives your Claude usage numbers.

- Paste the lines from [scripts/statusline-snippet.sh](scripts/statusline-snippet.sh) into your status line script, after the place where it reads `rate_limits`.
- The lines read the variables `RATE_5H`, `RATE_7D`, `RATE_5H_RESET`, `RATE_7D_RESET` and `SESSION_ID`. `RATE_5H` and `RATE_7D` are the percentages used in the 5-hour window and in the weekly (7-day) window. Set the ones your script has. The others are written as null.
- The limit rules need at least one of the two percentages. A window without a percentage never counts. The pace rule also needs the reset times. The snippet saves the session id too, but the limit rules do not use it.
- The lines write one sample, one reading of your usage, to `~/.claude/orchestrator/limits-latest.json`: the status line log. Without this file, the limit rules are off. Everything else works.
- A sample is too old after `limitsMaxAgeMs`, 10 minutes by default. When the sample is too old or cannot be read, the limit rules are off too. While Jev is on in `enforce` mode, the session start then says so once per session.
- The Claude Code desktop app runs no status line. All sessions on the machine read the same sample file. So in the desktop app, the limit rules act only while a terminal session on the same machine writes fresh samples.
- The setup check says when the file comes from an older snippet without the reset times.

### Check the setup

Run `/subagent-router:setup` in a session, or `node scripts/setup-check.mjs` from a clone. The check never prints a secret. The script names the next step for some items that are not OK, and the skill adds a next step for each of them.

Claude Code passes the plugin option only to hooks, so the check cannot see the key itself. Its row "TypeSafe key" reports where the routing hook found the key on its last routed call. `--live` also sends one test request to TypeSafe, but only when the key is in `TYPESAFE_API_KEY` and Jev is on.

## What leaves your machine

**To TypeSafe, only while Jev is on:**

- For each subagent call that the routing hook sends to Jev: the call's description, its whole brief and the text of five questions. By default this is almost every subagent call of the main session. The hook sends nothing for a call from inside a subagent, for `statusline-setup` and `claude-code-guide`, and for the agent types that you exclude below. An `orch-route: keep` line does not stop the send.
- When one of the plugin's own workers finishes: the `Verification:` part of its answer (the lines that say which checks ran), at most 2,000 characters, with one question. The file list and the rest of the answer stay on your machine.
- Only while the finding triage is on (`"triageMode": "log"`) and only for the checkouts listed in `triageProjects`: when a review agent finishes, or when any Codex review job ends (also a direct `node scripts/orch-codex.mjs review` run, from any session on this machine), each finding that cites code (at most 1,500 characters), with its label and the cited path and line range, and a short excerpt of the cited code (at most 6,000 characters, at most 12 findings per request), with one question per finding. Known token shapes, URL passwords, `Authorization` header credentials and secret-like assignments (any name that holds a word such as password, secret, token or api key) are masked before anything is cut or sent. A finding is held back whole when its text quotes the first or the last line of a private key, when a file that it cites holds such a line anywhere, or when it cites a file with a common credential name, such as `.env` or `*.pem`. No excerpt is read from a binary or UTF-16 file, and, for a review agent's report, none from a file that git ignores. Not caught, for example: a text that quotes only the body lines of a key, a name without one of the words (`DB_PASS`), a default value (`|| "secret"`), and a value split over lines. This masking is best effort, not a guarantee: names and other personal data in code are not masked, so list only checkouts whose code may leave your machine. For a Codex job, an excerpt is sent only when it provably equals the reviewed code, which only a commit review (`review --commit`) allows. The send can happen up to 10 minutes after the session that started the scan has ended, from a background process.
- A brief can hold code and project rules. A verification part can quote test output.
- To send less: `"routeOtherAgents": false` keeps the briefs of all agent types outside the plugin on your machine. `keepModelAgents` does the same for the agent types that it names. `"mode": "off"` sends nothing, and so does `"jevEnabled": false`, the default.
- `jevUrl` and `ORCH_TYPESAFE_URL` change where these requests go.

**To OpenAI, only while Codex is on:**

- The brief of each implement task, custom review and consult question, with an instruction snapshot: your personal and project Claude instruction files and their allowed imports. `codexIncludeUserRules` and `codexIncludeProjectRules` turn off the personal part and the project part. See [Instruction snapshot](REFERENCE.md#instruction-snapshot).
- Anything that Codex reads while it works. Its sandbox, the limits that Codex puts on its own commands, restricts where Codex can write. It does not restrict what Codex can read. So a job can read any file that your user can read, also outside the project, for example the dispatch log in `~/.claude/orchestrator/`. Write in the brief what Codex may read.

**Nothing else.** The plugin keeps the dispatch log, the Codex jobs and the settings in `~/.claude/orchestrator/`, readable only by your user. A Codex job can still read them, as described above. The TypeSafe key is never written to a log.

## How it works

1. The main session hands work to subagents: the plugin's seven workers, or any other agent type. The report calls the main session the orchestrator.
2. The plugin's routing hook sees every subagent call. It runs before each call of the `Agent` tool.
3. While Jev is on, the routing hook sends the brief to Jev and gets answers to [five questions](#what-jev-is-asked) about the task.
4. A table in code turns the answers into a route. For a call to one of the plugin's workers, the route is a worker and a model. For a call to any other agent type, the route is only a model.
5. When Jev is confident, the hook rewrites the call. When Jev is not confident, the call runs as the main session wrote it.
6. The hook writes every dispatch (one subagent call) to the dispatch log, with the main session's choice next to the table's route.

### The workers

| Worker | Runs on | Effort | Job |
| :-- | :-- | :-- | :-- |
| `subagent-router:searcher` | Haiku | none | Finds and explains code. Changes no files. |
| `subagent-router:complete-searcher` | Sonnet | `low` | Lists every match when the answer must be complete. Changes no files. |
| `subagent-router:implementer` | Sonnet | `high` | Writes and changes code inside a defined scope. |
| `subagent-router:debugger` | Opus | `medium` | Finds the cause of a failure. |
| `subagent-router:reviewer` | Sonnet | `high` | Reviews changes. Changes no files. |
| `subagent-router:codex-implementer` | Codex CLI, started by a small Haiku agent | from `~/.codex/config.toml` | Implements a task on the ChatGPT plan. Needs a self-contained brief. |
| `subagent-router:codex-reviewer` | Codex CLI, started by a small Haiku agent | from `~/.codex/config.toml` | Reviews the uncommitted changes, a branch or a commit. |

Effort is how much the model thinks before it answers. Each worker sets it in its agent file, so the effort of your session does not carry over; see [Effort](REFERENCE.md#effort).

When the main session calls one of these workers by name, the table still routes the task like any other task. The name counts only for `complete-searcher` and the two Codex workers. So while Codex is on, a direct call to `implementer`, `debugger` or `reviewer` can move to Codex, and a direct call can get another model, for example Opus for a hard task. See [Direct calls to the plugin's workers](REFERENCE.md#direct-calls-to-the-plugins-workers).

**The cross-review rule.** While Jev is on, a review goes to the other model family than the one that wrote the change:

- The Claude reviewer reviews a change that Codex wrote.
- Codex reviews a change that Claude wrote, when Codex can take work and the review brief is self-contained (`selfContainedGate`). A direct call to the Codex reviewer also goes to Codex, even when its brief is not self-contained.
- Otherwise, the Claude reviewer reviews the Claude change.

### Other agent types

Other agent types are the built-in agents (`Explore`, `Plan`, `general-purpose`), a project's own agents, and the agents of other plugins. Many projects start such agents from their own skills, for example a plan skill that starts a plan reviewer. For these calls, the plugin picks only the model:

- The hook sets `model` and does not change `subagent_type`. So the agent keeps its system prompt, its tools, its preloaded skills and its answer format. A project skill often reads that answer in a fixed format, and a swap to one of the plugin's workers would break it. The one exception is `codex:codex-rescue`; see [Codex](#codex).
- The `model` of a call comes first in Claude Code's order of model sources. So the hook's model wins over the `model:` line of the agent file, and over a model that a skill named in the call.
- Such a call never moves to Codex.

The table uses the same models as the Claude routes of the plugin's workers:

| Kind of task | Model |
| :-- | :-- |
| Search | `haiku` |
| Exact edit (the brief states the change exactly) | `haiku` or `sonnet` |
| Implementation | `sonnet`, or `opus` when it is hard |
| Debugging | `opus` |
| Review | `sonnet` |
| Design, or anything else | the model of the call |

**Keep an agent on its model.** Jev sees only the brief and never the agent file. So it cannot know that an agent runs on a small model on purpose, for example a narrow yes-or-no check on `haiku`. The table would send that review to `sonnet`. Put such an agent on the list `keepModelAgents`, by the name that the call uses in `subagent_type`: `spec-compliance-reviewer` for a project agent, `plugin-name:agent-name` for another plugin's agent. The agent then runs on the model named in the call, or on the model of its agent file when the call names none. The list works only for agents outside this plugin: the plugin's own workers and `codex:codex-rescue` on the list have no effect.

### When a plan is near its limit

- **Claude is near its limit** when its 5-hour or its weekly window is at 80 percent or more (`limitGate`), or is on pace to reach 100 percent before the window resets.
- **Codex cannot take work** while it is off, while it is paused after a usage limit, or while it is used up and `codexSpendCredits` is false.
- **Codex is near its limit** when the usage numbers that its last job saved are at 80 percent or more.

| Situation | What happens |
| :-- | :-- |
| Codex cannot take work | In `enforce` mode, tasks for the Codex workers run on Claude workers. |
| Claude is near its limit, Codex can take work, and Codex is not near its limit | Implementations, most edits, and debug tasks that change files go to Codex, when their brief is self-contained. Searches, reviews and diagnoses keep their route. |
| Claude is near its limit, and Codex cannot take work | The hook lowers every route that it picks from Opus to Sonnet. A call that the hook leaves alone keeps its model, even Opus. |
| Codex is near its limit, and Claude is not | Hard implementations run on Claude, on Opus. A direct call to the Codex implementer is no longer kept on Codex. |
| Both are near their limits, and Codex can take work | Every task takes its normal route. |
| Claude is used up | The main session stops. Go on in Codex by hand. |

The rules that depend on Claude's usage need Jev on and the status line log. In `enforce` mode, Claude Code shows a notice once per session when work moves to Codex because Claude is near its limit, when a model is lowered to Sonnet, and when a task for a Codex worker falls back to its Claude counterpart. Some moves show no notice; see [When a plan is near its limit](REFERENCE.md#when-a-plan-is-near-its-limit) for the exact conditions.

### Safety rules

**The hook fails open:** when something goes wrong, it lets the call run instead of blocking it. When the Jev call fails or the hook finds no key, the hook does not route the call. When the hook itself fails with an error, it prints nothing, and the call runs as the main session wrote it. The Jev timeout is `jevTimeoutMs`, 5 seconds by default. An error text from TypeSafe has the key removed before it is stored.

**The writer lock** is the one case in which the hook refuses a call on purpose. A writer is a task that changes files: a Codex implement job, or the plugin's `implementer` or `debugger`. In `enforce` mode, while one writer changes a checkout (one git working tree), the hook denies:

- a second writer or a reviewer of the plugin;
- a call to another agent type when Jev says that its task changes files.

So of two Claude writers sent in one message, only the first runs. A Codex implement job takes the lock only when the job starts. So a Claude writer sent in the same message can take the lock first, and the Codex job then fails with `writer_busy`. Edits by the main session are not covered. Time limits and stuck locks: see [The writer lock](REFERENCE.md#the-writer-lock).

## TypeSafe and Jev

[TypeSafe](https://typesafe.ai) is a third-party API. Its model Jev is a classifier: it writes no text, and it answers fixed questions with probabilities.

The plugin uses Jev because the routing needs a judgment about each task. Asking a Claude model would spend the same plan that the plugin tries to save. Jev answers in a few hundred milliseconds, and it costs much less than one subagent start.

### What Jev is asked

For each routed brief, Jev answers five questions:

1. What kind of task is it?
2. Does it change files?
3. Is the brief self-contained, so that a worker needs nothing from the conversation?
4. How hard is it?
5. Is the answer only right if it names every match?

A table in code, [scripts/lib/routing-table.mjs](scripts/lib/routing-table.mjs), turns the answers into a route. The questions are in [scripts/lib/questions.mjs](scripts/lib/questions.mjs).

When one of the plugin's workers finishes, the log hook, the plugin's hook that records the end of each worker, asks one more question about the `Verification:` part of the answer. Did the checks pass, fail or not run, or is it unclear? The report counts the answers. Without a Jev answer, the report uses a word search instead, which can read "no errors" as a failure. A count of zero, such as "0 failed" or "fail 0", counts as a pass. The report uses the word search while Jev is off, after a failed Jev call, and for older records.

### While Jev is off

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

### Cost and data policy

- You pay for Jev per input token: $0.042 per million tokens for Jev 1.13. Output is free. The price is from docs.typesafe.ai/models, checked on 2026-09-24.
- In our measurements, a routed brief had about 1,000 to 1,700 tokens. So a call costs about $0.00005, or about $1 per 20,000 dispatches.
- The question about a finished worker's checks sends one short question and at most 2,000 characters. It costs less than a routing call.
- `/subagent-router:report` counts the calls and shows how many of them changed a route. When that share stays near zero, Jev costs money and saves nothing, and you can turn it off.
- TypeSafe states that Jev is not trained on customer requests. See its [data handling](https://docs.typesafe.ai/models) and [legal](https://docs.typesafe.ai/legal) pages.

## Codex

The Codex CLI runs coding tasks on your ChatGPT plan. The plugin can send implement tasks and reviews to it, and you can ask it questions by hand. To turn it on, see [Setup](#turn-on-codex-optional).

**While Codex is off:**

- The routing table sends no task to Codex. Reviews go to `subagent-router:reviewer`.
- In `enforce` mode, a direct call to a Codex worker runs on a Claude worker.
- The Codex runner, the plugin's script that starts and watches Codex jobs, starts no job in any mode. It does not even run `codex login status`.
- A call to `codex:codex-rescue` passes unchanged. That agent belongs to OpenAI's separate Codex plugin for Claude Code.
- The setup check reports `Codex: off` and skips the Codex CLI checks.

**The `codex:codex-rescue` redirect.** OpenAI's Codex plugin has an agent `codex:codex-rescue` that describes itself as one to use proactively, so the main session may pick it on its own. That agent starts Codex outside this plugin, so the writer lock and the credit checks do not apply to it. So while Codex is on, in `enforce` mode, the hook sends a call to `codex:codex-rescue` to `subagent-router:codex-implementer`. It does this also when the brief has `orch-route: keep`. This blocks one known way to skip the routing, but other ways still exist. It also means that `/codex:rescue` runs the plugin's Codex implementer. To use OpenAI's agent, start the session with `ORCH_MODE=off`. This turns off all routing for that session.

**Credits and pauses.** When a Codex plan window, the 5-hour or the weekly one, reaches 100 percent, Codex goes on and spends your bought credits. The plugin blocks that by default:

- While the saved plan numbers show a window at 100 percent, the plugin starts no Codex job. This block ends at the reset time.
- After a job fails with a usage limit, the plugin starts no Codex job until the time that Codex named, or for one hour when it cannot read a time. Delete `codex-unavailable.json` in the data folder (`~/.claude/orchestrator/` by default) to end this pause early. This does not end the block in the bullet above.
- `"codexSpendCredits": true` allows credits. In `enforce` mode, routed Codex tasks still go to Claude during a pause. Details: [Credits and pauses](REFERENCE.md#credits-and-pauses).

**Ask Codex a question.** For a design question or a second opinion that is not a code review, use `consult`. The question comes on stdin, never on the command line:

```bash
node scripts/orch-codex.mjs consult --effort high < question.md
```

Codex answers in the read-only sandbox, so it changes no files. It can still read files outside the project; see [What leaves your machine](#what-leaves-your-machine). More in [Ask Codex a question](REFERENCE.md#ask-codex-a-question).

[REFERENCE.md](REFERENCE.md#codex) also covers how a task reaches Codex safely, the sandbox settings of each job, the instruction snapshot, custom and scoped reviews, and long runs and failures.

## Use

After the install and the setup, work as usual. The routing hook routes each subagent call by itself, and every dispatch goes to the log. `/subagent-router:report` shows what the routing did; see [The report](REFERENCE.md#the-report). `/subagent-router:configure` changes the settings.

To review a branch, a pull request or your uncommitted work, ask for a review or run `/subagent-router:review`. It reviews three things separately: the repository's documented rules (Standards), what the issue or plan asked for (Spec), and bugs (Correctness). Correctness goes to the other model family only when routing can move it: Jev on, the `enforce` mode, Codex on and able to take work, a brief that Jev reads as a self-contained review, and no Codex worker as the last worker that changed files in the session. With the default settings both parts run on Claude. The report names the model that really ran each part, and lists a problem that two parts found only once. It costs one worker dispatch for a small change that runs on Claude anyway, and two otherwise. Some of its instructions adapt MIT-licensed work; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

### Why was a call not rerouted?

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

Every action and reason is explained in [Actions in the log](REFERENCE.md#actions-in-the-log) and [Calls the hook leaves alone](REFERENCE.md#calls-the-hook-leaves-alone).

### Modes

| Mode | What the routing hook does |
| :-- | :-- |
| `enforce` (default) | Asks Jev, while Jev is on, and rewrites confident routes. Moves a task for a Codex worker to Claude while Codex cannot take work. Applies the writer lock. |
| `shadow` | Asks Jev, while Jev is on, and logs the route that it would take. Changes no route. |
| `off` | Logs the dispatch. Does not ask Jev. |

While Codex is on, the Codex workers can reach Codex in every mode. Set the mode in [the settings file](#configuration), or for one session with `ORCH_MODE=shadow claude ...`.

### Lines that a brief can carry

| Line | Effect |
| :-- | :-- |
| `codex-model: <name>` | The Codex model for this task. |
| `codex-effort: <none, minimal, low, medium, high, xhigh>` | The reasoning effort of Codex. |
| `review-scope: uncommitted` | Review the uncommitted changes. This is the default for a direct call to the Codex reviewer. |
| `review-scope: base:<branch>` or `commit:<hash>` | Review against a branch, or review one commit. |
| `review-scope: custom` | Send the brief to Codex as review instructions. Codex returns its whole answer. See [Codex reviews](REFERENCE.md#codex-reviews). |
| `orch-route: keep` | The hook runs this call as written: the same agent type and the same model. It works for every agent type except `codex:codex-rescue`. |

A Codex line that is present but not valid, for example `review-scope: branch:main`, stops the task with `CODEX_FAILED`. It never falls back in silence, because Codex would then review a different diff than the one you asked for.

**`orch-route: keep` is for a retry.** Jev sees only the brief. When a worker was blocked on a small model and the same brief starts again on a bigger one, Jev would pick the small model again. With this line, the retry stays on its model.

- Jev is still asked, so the log shows what the table would have picked.
- `orch-route: keep` must be the only text on its line. Any other value is ignored, and the log reports it in `brief_warnings`.
- It does not stop three things: the redirect of `codex:codex-rescue`, the move of a Codex task to Claude while Codex cannot take work, and the writer lock.
- It does keep a model above Sonnet while Claude is near its limit.

## Configuration

All settings live in one settings file, `~/.claude/orchestrator/config.json`. The file is optional: without it, every setting takes its default. There are three ways to change it.

**In a session.** `/subagent-router:configure` asks up to six questions and writes the settings file for you. It leaves the rest at their defaults and checks the setup afterwards. A session that finds no settings file says so once and offers this.

**With the command,** from a clone of this repository. It reads and writes the settings file directly:

```bash
node scripts/orch-config.mjs show                        # every setting, its value and where it comes from
node scripts/orch-config.mjs explain completeRule        # what one setting does and what it accepts
node scripts/orch-config.mjs set codexEnabled=true       # several key=value pairs at once
node scripts/orch-config.mjs unset limitGate             # back to the default
```

The command checks every value before it writes anything. So one wrong value writes nothing at all. A settings file that cannot be read is reported, not overwritten. Keys that the plugin does not know are left alone.

**By hand.** Write only the keys that you want to change:

```json
{
  "mode": "enforce",
  "codexEnabled": true,
  "keepModelAgents": ["spec-compliance-reviewer"]
}
```

When the plugin reads the settings file, a value that is not valid falls back to its default, and an unknown key is ignored. Both are reported in the session start text, the log and the setup check. A mode that is not valid, or a settings file that cannot be read at all, gives the mode `shadow`. So a typing mistake never rewrites calls.

### Routing

| Key | Default | Meaning |
| :-- | :-- | :-- |
| `mode` | `enforce` | `enforce`, `shadow` or `off`. See [Modes](#modes). |
| `kindGate` | `0.6` | The confidence that Jev needs in the kind of task before the hook rewrites a call. |
| `difficultyGate` | `0.5` | The confidence that Jev needs in the difficulty before the difficulty counts. Below it, the task takes the normal route for its kind. |
| `selfContainedGate` | `0.7` | How self-contained a brief must be before Codex gets the task. |
| `routeOtherAgents` | `true` | Let the hook set the model of a call to an agent type that is not one of the plugin's workers. |
| `keepModelAgents` | `[]` | Agent types from outside the plugin whose model the hook never changes, by exact name, for example `["spec-compliance-reviewer"]`. Their briefs are not sent to Jev. Names of the plugin's own workers and `codex:codex-rescue` have no effect. |

### Usage limits

| Key | Default | Meaning |
| :-- | :-- | :-- |
| `limitGate` | `80` | The usage percentage from which a plan counts as near its limit. For Claude, it applies to the 5-hour and the weekly window. The table then prefers Codex while Codex is not near its own limit, and caps routes at Sonnet when Codex cannot take work. For Codex, it applies to its saved plan usage. The table then keeps hard implementations and direct Codex implementer calls on Claude while Claude is not near its limit. |
| `pacing` | `true` | Also count a window as near its limit when the usage so far, at the same speed, would reach 100 percent before the reset. |
| `paceAfter` | `0.2` | How much of a window must pass before the pace rule counts, from 0 to 1. |
| `limitsMaxAgeMs` | `600000` | How long a usage sample stays usable, in milliseconds. Older samples are ignored, and the limit rules stay off. |

### Answer completeness

| Key | Default | Meaning |
| :-- | :-- | :-- |
| `completeRule` | `shadow` | What to do with a search that is only answered correctly by a complete list: `shadow`, `enforce` or `off`. |
| `completeGate` | `0.6` | How sure Jev must be that the answer needs every match before the rule counts, from 0 to 1. |

The values of `completeRule`:

- `shadow` changes no route. It records what it would have changed.
- `enforce` sends such a search to `complete-searcher` (Sonnet at effort `low`) instead of `searcher` on Haiku. For other agent types, such as `Explore`, it can change only the model, to Sonnet.
- `off` does neither.
- A search that the main session itself sends to `complete-searcher` stays there, whatever the value.

### Codex settings

| Key | Default | Meaning |
| :-- | :-- | :-- |
| `codexEnabled` | `false` | Let the plugin use Codex at all. While this is off, no task reaches Codex in any mode. |
| `codexSpendCredits` | `false` | Let a Codex job spend bought credits once a Codex plan window, the 5-hour or the weekly one, reaches 100 percent. It also lets the Codex runner start a job during the pause after a usage limit. See [Credits and pauses](REFERENCE.md#credits-and-pauses). |
| `codexIncludeUserRules` | `true` | Send `~/.claude/CLAUDE.md`, the files under `~/.claude/rules/` and their allowed imports with implement, custom review and consult briefs. |
| `codexIncludeProjectRules` | `true` | Send the `CLAUDE.md` files of the project and its parent folders, the `CLAUDE.local.md` files, the project rules and their allowed imports with implement, custom review and consult briefs. |

### Classifier and log

| Key | Default | Meaning |
| :-- | :-- | :-- |
| `jevEnabled` | `false` | Let the hooks send briefs, and the verification part of worker answers, to Jev. The routing needs it. See [TypeSafe and Jev](#typesafe-and-jev). |
| `jevModel` | `jev-latest` | The classifier version. Pin an exact version while you measure, so that a new Jev version cannot change the routing during the measurement. |
| `jevUrl` | the TypeSafe endpoint | Where the classifier request goes. |
| `jevTimeoutMs` | `5000` | How long to wait for an answer, from 100 to 8000. On a timeout, the call runs as written. |
| `promptLogChars` | `20000` | How much of a brief the log keeps. `0` keeps briefs out of the log entirely. |
| `resultLogChars` | `4000` | How much of a worker's answer the log keeps. |

### Finding triage

When a review agent finishes, the triage hook can split its report into findings, read the code that each finding cites, and ask Jev whether that code supports the finding. Codex reviews take another path: at the end of each turn and at session start, a short hook starts a background process that takes every finished Codex review job once, whoever started it. Both run in the background, so a session never waits for them, and both only log: no judgement reaches the session. They change no finding. The only triage text that a session shows is the daily progress line of an evaluation window, described below.

| Key | Default | Meaning |
| :-- | :-- | :-- |
| `triageMode` | `off` | `log` turns the triage on. It needs `jevEnabled` too. |
| `triageProjects` | `[]` | The checkout roots, as absolute paths, for which the triage may send findings and excerpts. A path counts only when it is exactly the root of the session's git checkout. `orch-config.mjs set` refuses a path that does not exist, is not in git, or is a folder below the root (it names the root), and it stores the real path, so a symbolic link cannot move later. Write a JSON list, or paths split by commas. Empty sends nothing. |
| `triageWorktrees` | `false` | `true` lets each checkout in `triageProjects` also cover every worktree of the same repository, including worktrees made later. The match is exact, never a path prefix: the same git common directory (the shared `.git` folder that all worktrees of one repository use), and git must list the folder as one of that checkout's worktrees. With `false`, a second worktree has its own root and needs its own entry. |
| `reviewFormats` | `[]` | Which agent types report findings with which labels, for example `[{"agentTypes":["my-reviewer"],"labels":["BLOCKING","SUGGESTION"],"emptyPhrases":["no findings"]}]`. The plugin's own reviewers and Codex reviews use `[P0]` to `[P3]` and need no entry. |

`node scripts/orch-label.mjs` measures whether Jev's judgements can be trusted before any of them could reach a session: `reserve`, `register --start <date> --end <date> [--agent-types <a,b>]` (a date alone means 00:00 UTC, so the end date itself is not in the window), `status`, `sample --name <name>`, `label <folder>` and `score <folder>`. You label a blind sample yourself, and the score is checked once against a fixed bar. Pin `jevModel` to an exact version first. While a window is registered, the session start shows its progress once a day, for all sessions together; you see the line, and the model gets it as session context. After the window ends, the line says what to run next, and once the window is scored it stops. See [Finding triage](REFERENCE.md#finding-triage).

### Settings for one session

These variables override the settings file for a single session, for example `ORCH_MODE=shadow claude ...`. They let you try something out without editing the file.

| Variable | Effect |
| :-- | :-- |
| `ORCH_MODE` | The mode: `enforce`, `shadow` or `off`. |
| `ORCH_CODEX_ENABLED` | `1` or `0`. Turns Codex on or off, whatever the settings file says. |
| `ORCH_JEV_ENABLED` | `1` or `0`. Turns Jev on or off, whatever the settings file says. |
| `ORCH_ROUTE_OTHER_AGENTS` | `1` or `0`. Whether the hook sets the model of other agent types. |
| `ORCH_COMPLETE_RULE` | `shadow`, `enforce` or `off` for the completeness rule. |
| `ORCH_JEV_TIMEOUT_MS` | The classifier timeout, in milliseconds. |
| `ORCH_TYPESAFE_URL` | Another classifier endpoint. |
| `ORCH_DATA_DIR` | Another folder for the log, the settings file and the usage samples. The status line snippet still writes to `~/.claude/orchestrator/`. Change `ORCH_DIR` in your copy of the snippet too, or the limit rules find no sample. |
| `ORCH_CODEX_WAIT_SECONDS` | How long a Codex worker waits for its job before it reports that the job still runs, from 0 to 570. |
| `ORCH_LOG_MAX_BYTES` | The size in bytes at which the dispatch log is rotated, 1024 or more. |

A few more variables exist for the tests and the evaluation runner, so they can run without a network, a key or a real Codex. You do not need them in normal use.

The files in the data folder are listed in [The data folder](REFERENCE.md#the-data-folder).

## Known limits

- **The writer lock has gaps.** It does not cover edits by the main session, and calls to other agent types take no lock. See [The writer lock](REFERENCE.md#the-writer-lock).
- **The `codex:codex-rescue` redirect** blocks one known way to skip the routing, not all of them.
- **Codex reports zero tokens for a scoped review,** so the log has no token count for those reviews. A custom review and a consult report their tokens.
- **The Codex plan numbers can be old or missing.** The plugin learns them only after a Codex job that it started, from Codex's internal session files. A Codex update can change these files; see [Codex plan numbers](REFERENCE.md#codex-plan-numbers). When the plugin cannot read the numbers, the plan counts as unknown.
- **So a job can spend credits although `codexSpendCredits` is `false`.** When the saved numbers are old, the plugin can miss that a Codex window has reached 100 percent.
- **The routing table and the gates are first guesses.** A gate is the lowest confidence, or the usage level, at which a rule acts. The log shows where Jev and the main session disagree. It cannot show which route would have been better. That needs the same tasks with routing on and off; see [EVALUATION.md](EVALUATION.md).
- **For another agent type, the hook does not read the agent file.** So the log cannot tell whether a rewrite changed the model that would have run. When the agent file already names the model of the table, the log still says `rewrite`. In `shadow` mode, the `launched` line shows the model that runs without a rewrite.
- **The finding triage only logs.** Its judgements reach no session until an evaluation passes, and that step is not built yet. Many review agents cite no `file:line`, and a finding without a citation gets no judgement, so a sample can take weeks to fill. For Codex jobs, only commit reviews give evidence; base, uncommitted and custom reviews are parsed and counted, but nothing of them is sent, because Codex compares them with the working tree, which can change before the triage reads it.
- **The Sonnet cap is narrow.** It covers only the routes that the table picks, and only while Codex cannot take work. While Codex can take work, a hard task that does not move to Codex still runs on Opus when Claude is near its limit. Examples: a call to another agent type, a diagnosis that changes no files, and a hard implement or debug task whose brief is not self-contained.

## More documentation

- [REFERENCE.md](REFERENCE.md): how the routing decides, the writer lock, how Codex jobs run, the data folder and the report.
- [EVALUATION.md](EVALUATION.md): the offline evaluation, which runs the same tasks with routing on and off to measure whether the routing saves money.
- [CHANGELOG.md](CHANGELOG.md): what changed in each version.
- [SECURITY.md](SECURITY.md): how to report a security problem.

## Develop the plugin

Clone the repository and load it for one session with a flag:

```bash
claude --plugin-dir /path/to/claude-subagent-router
```

- Do not use the flag in a project where the plugin is installed.
- After a change to the plugin files, run `/reload-plugins` in the session, or start a new one.

```bash
npm test
```

- The tests need no network and no key. They use a local stand-in for the TypeSafe API and a stand-in for the `codex` command.
- `npm run check` checks the syntax of every script.
- `npm run test:boundaries` checks the sandbox of the evaluation runner; see [EVALUATION.md](EVALUATION.md).
