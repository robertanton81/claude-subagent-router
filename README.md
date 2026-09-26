# Claude Subagent Router

A Claude Code plugin that picks the model for each subagent task. It sends a task to the smallest Claude model that can do it, and it can move work to the Codex CLI.

## Why

A Claude Code session hands work to subagents: searches, edits, reviews, debugging. Without routing, a subagent often runs on the same large model as the main session, even for a simple file search. That uses up the 5-hour and weekly limits of a Claude subscription faster than needed.

The plugin reads each task before it starts and picks a model that fits it: Haiku for a search, Sonnet for most edits and reviews, Opus for hard work. If you turn Codex on, the plugin moves tasks to Codex when your Claude usage gets close to its limit, so your ChatGPT subscription takes part of the work. Reviews then cross the two model families: Codex reviews what Claude wrote, and Claude reviews what Codex wrote.

The plugin calls no Claude or OpenAI API; the work stays inside your subscriptions. The one paid API is TypeSafe's classifier Jev, which reads each task, at about $0.00005 per call. It is off until you turn it on; see [TypeSafe and Jev](#typesafe-and-jev).

## Requirements

- Claude Code with a Claude subscription. The plugin changes which model a subagent uses; it calls no Claude API itself.
- Node.js 20 or newer. The plugin has no npm dependencies.
- For the routing: a TypeSafe API key for Jev, the classifier that reads each brief. Jev is off until you turn it on; see [TypeSafe and Jev](#typesafe-and-jev).
- Optional: the Codex CLI with a ChatGPT login, to send work to Codex. Codex jobs need macOS or Linux. On Windows the routing between Claude models works, and Codex stays off.

## Install

This repository is also a marketplace (a catalog of plugins that Claude Code can install from), in `.claude-plugin/marketplace.json`. Add it once, then install the plugin for one project:

```bash
claude plugin marketplace add robertanton81/claude-subagent-router
```

```bash
cd /path/to/your-project && claude plugin install subagent-router@claude-subagent-router --scope local
```

`--scope local` writes the switch to `.claude/settings.local.json` of that project, which git does not track. Leave `--scope` out to turn the plugin on in every project. `claude plugin marketplace update claude-subagent-router` fetches a new version.

Then follow the setup below. Until you turn Jev on, the hook sends nothing to TypeSafe and changes no route.

## Setup

Run the check at any time with `/subagent-router:setup` in a session. From a clone of this repository the same check is `node scripts/setup-check.mjs --live`. It never prints a secret.

0. **Settings.** Run `/subagent-router:configure` in a session and answer its questions, or leave everything at its default and come back to the [Configuration](#configuration) section later. Codex stays off until you turn it on.
1. **Codex CLI (only to use Codex).** Install it, run `codex login` with your ChatGPT account, and turn Codex on with `/subagent-router:configure` or `node scripts/orch-config.mjs set codexEnabled=true`.
2. **Jev and its key (for the routing).** Follow the four steps in [TypeSafe and Jev](#typesafe-and-jev): create a key, store it in the plugin option, set `jevEnabled` to true, and check it.
3. **Status line log (optional).** The limit rule and the measurement need the two rate limit percentages, their reset times and the session id. Only the status line receives them. Paste the lines from [scripts/statusline-snippet.sh](scripts/statusline-snippet.sh) into your status line script, after the place where it reads `rate_limits`. The block reads the variables `RATE_5H`, `RATE_7D`, `RATE_5H_RESET`, `RATE_7D_RESET` and `SESSION_ID`; set the ones your script has, and the others are written as null. Without this file the limit rule is off, and everything else works. When the file exists but its sample is too old (`limitsMaxAgeMs`, 10 minutes by default) or cannot be read, the session start says once per session that the limit rule is off. This happens in the Claude Code desktop app, which runs no status line. `node scripts/setup-check.mjs` says when the file is there but comes from an older snippet without the reset times.
4. **Permission for the Codex workers (optional).** The Codex workers run one Bash command. To avoid a prompt each time, allow it in your settings: `Bash(node */scripts/orch-codex.mjs *)`.

## What leaves your machine

- **To TypeSafe, only while Jev is on:** the brief (the prompt) of each `Agent` call that the hook routes, and the `Verification:` part of each answer from the plugin's own workers (at most 2,000 characters; the file list and the rest of the answer stay here). Nothing else. A brief can hold code and project rules, and a verification part can quote test output. Set `"routeOtherAgents": false` to keep the briefs of agent types other than the plugin's own workers on your machine, or set `"mode": "off"` to send none.
- **To OpenAI, only while Codex is on:** the task brief and an instruction snapshot for implement tasks and custom reviews. The snapshot includes personal `CLAUDE.md` and `.claude/rules/`, plus project and parent `CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md`, `.claude/rules/`, and allowed imports. The two rule switches below control personal and project sources separately. Project imports and symlinks cannot leave their source boundary; see “Instruction snapshot” below.
- **Nothing else.** The dispatch log, the Codex jobs and the settings stay in `~/.claude/orchestrator/`, readable only by your user. The TypeSafe key is never written to a log.

## TypeSafe and Jev

**What it is.** [TypeSafe](https://typesafe.ai) is a third-party API. Its model Jev is a classifier: it does not write text, it answers fixed questions with probabilities. The plugin asks Jev five questions about each brief: the kind of task, whether it changes files, whether the brief is self-contained, how hard it is, and whether the answer must name every match. A table in code turns the answers into a route. When one of the plugin's workers finishes, the log hook asks one more question: did the checks named in its `Verification:` line pass, fail, or not run? The report counts the answers. Before, a word search did this and read "0 fail" or "no errors" as a failure. The questions are in [scripts/lib/questions.mjs](scripts/lib/questions.mjs).

**Why the plugin uses it.** The routing needs a judgment about each task, and asking a Claude model for it would spend the same subscription the plugin tries to save. Jev answers in a few hundred milliseconds, and it costs much less than one subagent start.

**It is opt-in.** Jev is off until you turn it on, like Codex. While it is off:

- The hook sends nothing to TypeSafe and does not look for a key.
- It changes no model. The orchestrator can still pick the plugin's workers, and each runs on the model of its agent file: `searcher` on Haiku, `implementer` on Sonnet, and so on.
- The rest still works: the Codex workers and their transport, the move of a Codex task to Claude while Codex has no room, the writer lock for the plugin's own workers, and the log.
- The usage rules do not act, because they work through the routing table: nothing moves to Codex and nothing is capped at Sonnet when Claude usage is high.

**Turn it on:**

1. Create a key in the TypeSafe console: https://console.typesafe.ai/keys.
2. Store the key in the plugin option. Copy the key, then run this in a terminal. Add the `--scope` of your install, for example `--scope local` in the project folder:

   ```bash
   k=$(pbpaste) && claude plugin install subagent-router@claude-subagent-router --config "typesafe_api_key=$k"; unset k; pbcopy </dev/null
   ```

   `pbpaste` reads the key from the clipboard, so it is never typed, printed or kept in the shell history, and `pbcopy </dev/null` clears the clipboard. On Linux, use `xclip -o -selection clipboard` or `wl-paste` instead of `pbpaste`. The command also works when the plugin is already installed: it keeps the install and sets the option. Claude Code keeps a sensitive option in the macOS Keychain, or in `~/.claude/.credentials.json` on other systems, and passes it only to this plugin's hooks. The Claude Code docs also describe a prompt for the option when the plugin is enabled. For scripts, CI and the evaluation runner, the variable `TYPESAFE_API_KEY` works too. No other place is read: no key file in your home folder, and never a `.env` in a project, because a cloned repository could ship its own key and receive your briefs in its own TypeSafe account.
3. Set `"jevEnabled": true` with `/subagent-router:configure` or `node scripts/orch-config.mjs set jevEnabled=true`. For one session, `ORCH_JEV_ENABLED=1` or `0` overrides the file. A key alone does not turn Jev on.
4. Start a new session and let it delegate one task, then run `/subagent-router:setup`. Claude Code passes the plugin option only to hooks, so the check cannot see the key itself; its row "TypeSafe key" reports where the hook found the key on its last routed call.

**What it sends.** One request per routed `Agent` call: the call's description and its whole prompt, plus the five questions. Nothing else from your machine. A prompt can hold code and project rules. `"routeOtherAgents": false` limits the requests to calls to the plugin's own workers, and `"mode": "off"` stops them all. TypeSafe states that Jev is not trained on customer requests; see its [data handling](https://docs.typesafe.ai/models) and [legal](https://docs.typesafe.ai/legal) pages.

**What it costs.** Jev is paid per input token: $0.042 per million tokens for Jev 1.13 (output is free; price from docs.typesafe.ai/models, checked 2026-09-24). A routed brief measured about 1,000 to 1,700 tokens, so a call costs about $0.00005, or about $1 per 20,000 dispatches. The question about a finished worker's checks sends one short question and at most 2,000 characters, so it costs less than a routing call. `/subagent-router:report` counts the calls and shows how many of them changed a route. When that share stays near zero, Jev costs money and saves nothing, and you can turn it off.

**When it fails.** On a timeout (`jevTimeoutMs`, 5 seconds by default), an HTTP error or a missing key, the call runs as the orchestrator wrote it. The key is never written to a log; an error text from TypeSafe has the key removed before it is stored.

## How it works

1. The main Claude Code session is the orchestrator. It hands work to seven workers.
2. A `PreToolUse` hook (a script that Claude Code runs before a tool call) sees every `Agent` call.
3. The hook sends the brief to Jev, the TypeSafe classifier. Jev answers five questions: the kind of task, whether it changes files, whether the brief is self-contained, how hard it is, and whether the answer is only right if it names every match.
4. A table in code maps the answers to a route. For a call to one of our workers, the route is a worker and a model. For a call to any other agent type, the route is only a model. When Jev is confident, the hook rewrites the call. When Jev is not confident, the orchestrator's choice stands.
5. The hook writes every dispatch to a log, with the orchestrator's choice next to Jev's choice.

| Worker | Runs on | Effort | Job |
| :-- | :-- | :-- | :-- |
| `subagent-router:searcher` | Haiku | none | Finds and explains code. Changes no files. |
| `subagent-router:complete-searcher` | Sonnet | `low` | Lists every match when the answer must be complete. Changes no files. A search the orchestrator sends to it stays there. |
| `subagent-router:implementer` | Sonnet | `high` | Writes and changes code inside a defined scope. |
| `subagent-router:debugger` | Opus | `medium` | Finds the cause of a failure. |
| `subagent-router:reviewer` | Sonnet | `high` | Reviews changes. Changes no files. |
| `subagent-router:codex-implementer` | Codex CLI | Codex settings | Implements a task on the ChatGPT plan. Needs a complete brief. A task the orchestrator sends to it stays there while Codex can take it. |
| `subagent-router:codex-reviewer` | Codex CLI | Codex settings | Reviews the uncommitted changes, a branch or a commit. A review the orchestrator sends to it stays there while Codex can take it, unless Codex wrote the change. |

Effort is how much the model thinks before it answers. Each Claude worker sets it in its agent file, at the default of its own model (Sonnet 5 `high`, Opus 5.5 `medium`), so the session's effort does not carry over to the workers. Haiku 4.5 takes no effort. The level stays when the hook changes the model: an implementer moved to Opus runs at `high`. The variable `CLAUDE_CODE_EFFORT_LEVEL` overrides it. The Codex workers use the model and effort of `~/.codex/config.toml`, unless the brief has a `codex-model:` or `codex-effort:` line.

Reviews cross the model families: Codex reviews changes from Claude, and the Claude reviewer reviews changes from Codex.

### Other agent types

Other agent types are the built-in agents (`Explore`, `Plan`, `general-purpose`), a project's own agents, and the agents of other plugins. Many projects start such agents from their own skills, for example a plan skill that starts a plan reviewer.

For these calls the plugin decides the model, and the agent file keeps the rest:

- The hook sets only `model`. It never changes `subagent_type`. So the agent keeps its system prompt, its tools, its preloaded skills and its answer format. A project skill often reads that answer in a fixed format, and a swap to one of our workers would break it.
- The `model` of a call comes first in the model order of Claude Code. So the hook's model wins over the `model:` line of the agent file, and over a model that a skill named in the call.
- The table is the Claude part of the table for our workers: a search runs on `haiku`, an exact edit on `haiku` or `sonnet`, an implementation on `sonnet`, or on `opus` when it is hard, a debug task on `opus`, and a review on `sonnet`. A design task and anything else keep the model of the call.

The hook leaves a call alone in these cases:

- The call comes from inside a subagent.
- The agent type is `statusline-setup` or `claude-code-guide`. Claude Code runs them on a fixed model.
- The agent type is on the list `keepModelAgents` in `config.json`. Jev sees only the brief and never the agent file. So it cannot know that an agent runs on a small model on purpose, for example a narrow yes-or-no check on `haiku`. The table would send that review to `sonnet`. Put such an agent on the list by its exact name.
- `routeOtherAgents` is `false`. `ORCH_ROUTE_OTHER_AGENTS=0` does the same for one session.

The briefs of these calls go to TypeSafe, like the briefs for our workers. A project brief can hold code and project rules. With `"routeOtherAgents": false`, such a brief stays on your machine.

### Codex is opt-in

Codex is off until you turn it on. While it is off:

- The routing table sends no task to Codex. Reviews go to `subagent-router:reviewer`.
- A direct call to a Codex worker runs on its Claude counterpart, `implementer` or `reviewer`, on Sonnet. Claude Code shows one notice per session.
- The runner starts no Codex job in any mode, and it does not even run `codex login status`.
- A call to the Codex plugin's own agent `codex:codex-rescue` passes unchanged. The hook redirects it to `subagent-router:codex-implementer` only while Codex is on.
- The setup check reports `Codex: off` and skips the Codex CLI checks.
- When Claude usage is high, no work can move to Codex. The hook then picks no model above Sonnet. See the next section.

To turn Codex on for all sessions, put `"codexEnabled": true` in `~/.claude/orchestrator/config.json`. For one session, start Claude Code with `ORCH_CODEX_ENABLED=1`. The variable wins over the file, so `ORCH_CODEX_ENABLED=0` turns Codex off for one session.

The hook fails open. On a timeout, an HTTP error, a missing key or any bug, it prints nothing, and the call runs as the orchestrator wrote it. There is one deliberate "no": in `enforce` mode the hook denies a writer or a reviewer of the plugin while another writer still changes files in the same checkout. A checkout is the root of the git working tree, so a writer in `repo/src` and a writer in `repo` count as the same checkout; another worktree is a checkout of its own. The other writer is a Codex job, or a Claude writer (`implementer`, `debugger`) that runs as a subagent. A Claude writer takes the lock when the hook lets it through, so of two writers sent in one message only the first runs. It also denies an agent type of another owner, such as `general-purpose`, when Jev says that its task changes files. Without a Jev answer such a call runs.

### When one subscription has no room

The work goes on with the other provider, and you are told once per session. The first two rules apply only while Codex is on.

- **Codex has no room.** Every task for a Codex worker runs on its Claude counterpart: `implementer` or `reviewer`, on Sonnet. Claude Code shows a notice, and a new session shows it at its start.
- **Claude has little room.** From 80 percent of the 5-hour or the 7-day window, tasks with a complete brief run on Codex. This needs the status line log from the setup below. A window also counts as full when the usage so far, continued at the same speed, reaches 100 percent before the window resets (the pace rule): 50 percent used after two hours of the 5-hour window is on pace for 125 percent, so it counts; 50 percent used after four hours is on pace for 63 and does not. The pace rule needs the reset times from the status line log, it counts only after 20 percent of a window has passed, and the notice then names the pace. `"pacing": false` in `config.json` turns it off; `"paceAfter"` moves the 20 percent.
- **Claude has little room, and Codex cannot take work.** Codex cannot take work while it is off, paused or used up. From 80 percent, the hook then picks no model above Sonnet: a hard task and a debug task run on Sonnet, not on Opus. This holds for our workers and for other agent types, and it needs the status line log too. The rule covers only the routes that the table picks. A call that the table leaves alone can still run on Opus.
- When both are at 80 percent or more, and Codex can still take work, every task takes its normal route.
- One thing the plugin cannot do: the main session is a Claude session. When Max is fully used up, that session stops, and no hook runs. You then go on in Codex by hand.

Codex and credits: when a Codex plan window (the 5-hour or the weekly one) reaches 100 percent, Codex does not stop. It goes on and pays from your bought credits. The plugin does not allow that by default. It treats 100 percent as "no room" and starts no Codex job until the reset time. After a job fails with a usage limit, it also starts no Codex job until the time that Codex named. To allow credits, set `"codexSpendCredits": true` in `config.json`. After each job, the `CODEX_JOB` line shows `codex_used=<percent>`, and a run that was paid from credits says so, with the balance.

### How a task reaches Codex

Task text is not trusted. It can quote a web page or an issue. So it never goes into a shell command:

1. The hook stores the task in `~/.claude/orchestrator/codex-requests/<request id>.json`.
2. The thin Codex worker receives only `codex-request: req-<12 hex characters>`. It never sees the task text.
3. The worker runs `node scripts/orch-codex.mjs run <request id>`. The id has a fixed shape, and the command checks it.
4. The runner removes `CODEX_API_KEY` and `OPENAI_API_KEY` from Codex's environment and checks `codex login status`. Without a ChatGPT login the job stops, so a run is never billed at API rates.
5. The runner adds a Claude instruction snapshot to implement briefs and custom review briefs. Codex also discovers its own `AGENTS.md` files. Scoped reviews (`--uncommitted`, `--base`, `--commit`) receive no brief and no snapshot.
6. A request id works only for the session, the folder and the kind of job that stored it.

### Instruction snapshot

Personal instructions load first: `~/.claude/CLAUDE.md` and all Markdown files under `~/.claude/rules/`. Project sources follow from the filesystem root down to the task folder. Each level contributes `CLAUDE.md`, `.claude/CLAUDE.md`, recursive `.claude/rules/`, then `CLAUDE.local.md`. A rule keeps its YAML `paths` condition and its base directory. Codex is told to apply it only to matching files; the runner does not enforce that condition.

Imports such as `@guides/testing.md` expand relative to the containing file. Absolute paths and `~/` paths also work. Imports in backticks or fenced code blocks stay literal. Expansion stops at four hops and detects cycles. Import paths containing whitespace are not supported. Within a checkout, project imports and symlinks must stay inside that checkout. An ancestor outside the checkout may reference files inside its own directory. Each imported file keeps the original boundary. Personal instruction imports are trusted, but conventional credential filenames such as `.env`, `.credentials.json`, `.npmrc`, private key files, and anything under `.git/` are skipped.

The runner cannot inspect Claude's external-import approval state. It therefore skips project imports outside their boundary even if you approved them in Claude. It records skipped sources and truncation in `job.json` under `rules` and warns on stderr. File content is limited to 16,000 characters per file and 128,000 characters in total, with at most 256 file reads and 256 import attempts. The final snapshot is capped at 160,000 characters, including labels. Diagnostics and rule traversal also have bounds. Sources load in the order above, so a limit can omit later, more specific instructions. Check the recorded notes when a warning appears.

This is a file snapshot, not a copy of the Claude session. It does not load instructions on demand from child directories, managed policy, auto memory, additional directories, or Claude settings such as `claudeMdExcludes`. Put any extra instructions needed by the task in its brief. Turning off a rule switch stops automatic discovery for that scope; an explicit import in an enabled source still follows the import rules above.

## Use

After the install and the setup, work as usual. The hook routes each subagent call by itself, and every dispatch goes to the log. `/subagent-router:report` shows what the routing did, and `/subagent-router:configure` changes the settings.

### Work on the plugin

Clone the repository and load it for one session with a flag:

```bash
claude --plugin-dir /path/to/claude-subagent-router
```

Do not use the flag in a project where the plugin is installed. After a change to the plugin files, run `/reload-plugins` in the session, or start a new one.

### Modes

| Mode | What the hook does |
| :-- | :-- |
| `enforce` (default) | Asks Jev and rewrites confident routes. Denies a second writer while a Codex job writes. |
| `shadow` | Asks Jev and logs the route. Changes nothing. |
| `off` | Logs the dispatch. Does not ask Jev. |

The transport for the Codex workers works in every mode. Set the mode in the configuration file below, or for one session with `ORCH_MODE=shadow claude ...`.

### Lines that a brief can carry

| Line | Effect |
| :-- | :-- |
| `codex-model: <name>` | The Codex model for this task. |
| `codex-effort: <none, minimal, low, medium, high, xhigh>` | The reasoning effort of Codex. |
| `review-scope: uncommitted` | Review the uncommitted changes. This is the default for a direct call to the Codex reviewer. |
| `review-scope: base:<branch>` or `commit:<hash>` | Review against a branch, or review one commit. |
| `review-scope: custom` | Send the brief to Codex as review instructions, with no scope flag. |
| `orch-route: keep` | The hook runs this call exactly as written: the same agent type and the same model. It works for every agent type. |

Codex refuses review instructions together with a scope flag. So a scoped review uses Codex's own review rules, and only a `custom` review reads the brief.

When the hook moves a review from `subagent-router:reviewer` to Codex and the brief names no scope, the request gets the scope `custom`, so the brief travels as the review instructions and nothing of it is lost. Before this, such a review became a review of the uncommitted changes, which is an empty diff in a clean checkout. The dispatch record shows the scope in `review_scope`, and the request file says in `scope_source` whether the scope came from the brief, from the routing or from the default.

A Codex line that is present but not valid, for example `review-scope: branch:main`, stops the task with `CODEX_FAILED`. It never falls back in silence, because Codex would then review another diff than the one you asked for.

`orch-route: keep` is for a retry. Jev sees only the brief. When a worker was blocked on a small model and the same brief starts again on a bigger one, Jev would pick the small model again. With this line the retry stays on its model. Jev is still asked, so the log shows what the table would have picked. The line must stand on a line of its own. Any other value is ignored, and the log reports it in `brief_warnings`. The line does not stop the move of a Codex task to a Claude worker while Codex has no room, and it does not stop the writer lock. It does keep a model above Sonnet while Claude usage is high.

## Configuration

There are two ways to set this up. Inside a session, `/subagent-router:configure` asks what you want and writes the file for you. It asks about the five things that matter, leaves the rest at their defaults, and checks the setup afterwards. A session that finds no settings file says so once and offers it.

Outside a session, the same command reads and writes the file directly:

```bash
node scripts/orch-config.mjs show                        # every setting, its value and where it comes from
node scripts/orch-config.mjs explain completeRule        # what one setting does and what it accepts
node scripts/orch-config.mjs set codexEnabled=true       # several key=value pairs at once
node scripts/orch-config.mjs unset limitGate             # back to the default
```

Every value is checked before anything is written, so one wrong value writes nothing at all, and a file that cannot be read is reported rather than overwritten. Keys the plugin does not know are left alone.

All settings live in one file, `~/.claude/orchestrator/config.json`. It is optional: without it every setting takes its default. You can also edit it by hand. Write only the keys you want to change.

```json
{
  "mode": "enforce",
  "codexEnabled": true,
  "keepModelAgents": ["spec-compliance-reviewer"]
}
```

### Routing

| Key | Default | Meaning |
| :-- | :-- | :-- |
| `mode` | `enforce` | `enforce` rewrites confident routes, `shadow` only logs what it would do, `off` asks Jev nothing. |
| `kindGate` | `0.6` | The confidence Jev needs in the kind of task before the hook rewrites a call. |
| `difficultyGate` | `0.5` | The confidence Jev needs in the difficulty before the difficulty counts. Below it, the task takes the normal route for its kind. |
| `selfContainedGate` | `0.7` | How self-contained a brief must be before Codex gets the task. |
| `routeOtherAgents` | `true` | Let the hook set the model of a call to an agent type that is not one of the plugin's workers. |
| `keepModelAgents` | `[]` | Agent types whose model the hook never changes, by exact name, for example `["spec-compliance-reviewer"]`. |

### Usage limits

| Key | Default | Meaning |
| :-- | :-- | :-- |
| `limitGate` | `80` | The percentage of the 5-hour or 7-day window from which the table prefers Codex. |
| `pacing` | `true` | Also count a window as full when the usage so far, continued at the same speed, reaches 100 percent before the reset. |
| `paceAfter` | `0.2` | How much of a window must pass before the pace rule counts, from 0 to 1. A projection from the first minutes is noise. |
| `limitsMaxAgeMs` | `600000` | How long a usage sample stays usable, in milliseconds. Older samples are ignored and the limit rules stay off. |

### Answer completeness

| Key | Default | Meaning |
| :-- | :-- | :-- |
| `completeRule` | `shadow` | What to do with a search that is only answered correctly by a complete list. `shadow` changes no route and records what it would have changed, `enforce` sends such a search to `complete-searcher` (Sonnet at effort `low`) instead of `searcher` on Haiku; for other agent types, such as `Explore`, it can change only the model, to Sonnet. `off` does neither. A call the orchestrator itself sends to `complete-searcher` stays there in every mode. |
| `completeGate` | `0.6` | How sure Jev must be that the answer needs every match before the rule counts, from 0 to 1. |

### Codex

| Key | Default | Meaning |
| :-- | :-- | :-- |
| `codexEnabled` | `false` | Let the plugin use Codex at all. While this is off, no task reaches Codex in any mode. |
| `codexSpendCredits` | `false` | Let a Codex job pay from bought credits once the weekly allowance is used up. |
| `codexIncludeUserRules` | `true` | Send personal `CLAUDE.md`, recursive rules and allowed imports with implement and custom review briefs. |
| `codexIncludeProjectRules` | `true` | Send project and parent instructions, local files, recursive rules and allowed imports with implement and custom review briefs. |

### Classifier and log

| Key | Default | Meaning |
| :-- | :-- | :-- |
| `jevEnabled` | `false` | Let the hooks send briefs, and the verification part of worker answers, to Jev. The routing needs it. See [TypeSafe and Jev](#typesafe-and-jev). |
| `jevModel` | `jev-latest` | The classifier version. Pin an exact version while measuring, so the routing cannot change under you. |
| `jevUrl` | the TypeSafe endpoint | Where the classifier request goes. |
| `jevTimeoutMs` | `5000` | How long to wait for an answer, from 100 to 8000. On a timeout the call runs as written. |
| `promptLogChars` | `20000` | How much of a brief the log keeps. `0` keeps briefs out of the log entirely. |
| `resultLogChars` | `4000` | How much of a worker's answer the log keeps. |

A value that is not valid falls back to its default, and an unknown key is ignored. Both are reported in the session start text, the log and the setup check. A mode that is not valid, or a file that cannot be read at all, gives the mode `shadow`, so a typing mistake never rewrites calls.

### Settings for one session

These variables override the file for a single session, for example `ORCH_MODE=shadow claude ...`. They are meant for trying something out without editing the file.

| Variable | Effect |
| :-- | :-- |
| `ORCH_MODE` | The mode: `enforce`, `shadow` or `off`. |
| `ORCH_CODEX_ENABLED` | `1` or `0`. Turns Codex on or off, whatever the file says. |
| `ORCH_JEV_ENABLED` | `1` or `0`. Turns Jev on or off, whatever the file says. |
| `ORCH_ROUTE_OTHER_AGENTS` | `1` or `0`. Whether the hook sets the model of other agent types. |
| `ORCH_COMPLETE_RULE` | `shadow`, `enforce` or `off` for the completeness rule. |
| `ORCH_JEV_TIMEOUT_MS` | The classifier timeout, in milliseconds. |
| `ORCH_TYPESAFE_URL` | Another classifier endpoint. |
| `ORCH_DATA_DIR` | Another folder for the log, the configuration and the usage samples. |
| `ORCH_CODEX_WAIT_SECONDS` | How long a Codex worker waits for its job before reporting that it still runs, from 0 to 570. |

A few more variables exist for the tests and the evaluation runner, so they can run without a network, a key or a real Codex. They are not needed in normal use.

The routing table is [scripts/lib/routing-table.mjs](scripts/lib/routing-table.mjs). The questions for Jev are in [scripts/lib/questions.mjs](scripts/lib/questions.mjs).

## The log

Everything is in `~/.claude/orchestrator/`. The log holds your briefs, so it stays outside the repository. The folder is created with mode 0700, and the files that hold briefs, results or dispatch records with mode 0600. A folder or a file from an older version with a wider mode is tightened on the next write. Set `promptLogChars: 0` in `config.json` to keep the text of briefs out of the log; the record then keeps the description and the routing facts. Nothing inside a brief is masked. Only the TypeSafe key is.

| File | Content |
| :-- | :-- |
| `dispatch-log.jsonl` | One line per event: `session`, `dispatch`, `launched`, `start`, `stop`, `hook_error`. Every line carries `cwd`, the project folder of the session, so one log serves every project. At 25 MB the file is renamed to `dispatch-log.1.jsonl` and replaces the older one, so the log takes at most two files of that size. `ORCH_LOG_MAX_BYTES` changes the limit, in bytes, 1024 or more. |
| `writers.jsonl` | A small index of who changed files: the plugin's writer workers, and every Claude `Edit`, `Write`, `MultiEdit` or `NotebookEdit` call, also from the main session. The cross-review rule reads it. A `PostToolUse` hook on these tools writes one short line per call. |
| `codex-requests/` | The stored tasks for the Codex workers. Removed after 14 days. |
| `codex-jobs/<id>/` | The brief, the events, the error output and the result of each Codex run. Removed after 14 days. |
| `locks/` | One lock per checkout while a writer changes files there. For a Codex job it names the job and the process that started it, so it holds from the start on, before the runner has written its pid. For a Claude writer it names the session and, once the subagent has started, the subagent; it is given back when the subagent stops. |
| `codex-limits.json` | The last limit numbers of Codex: percent used, reset time, credits balance. Saved after each Codex job. Numbers that may be older than the saved ones do not replace them. |
| `notices/` | One empty file for each notice that a session has already shown, named by a hash of the session id. A file is created in one step that only one hook can win, so parallel dispatches show a notice once. Files older than 14 days are removed. A `notices.json` from a version before 2026-09-23 is no longer read and can be deleted. |
| `codex-unavailable.json` | Written when a Codex job fails with a usage limit. Until the time in it, the routing sends no tasks to Codex, and the runner starts no Codex job unless `codexSpendCredits` is true. Delete the file to end the pause early. |
| `limits-latest.json`, `limits.jsonl` | Written by the status line snippet: the two percentages, the two reset times (Unix epoch seconds) and the session whose status line saw them. `limits-latest.json` is the newest sample, and `limits.jsonl` has one line per change. |

### The report

```bash
node scripts/orch-report.mjs
```

Inside a session the same report is `/subagent-router:report`. It reads the whole store (`dispatch-log.jsonl`, its rotated file and `limits.jsonl`) and prints counts only: no brief, no description and no worker result reaches the output. `--json` prints the same numbers as JSON, `--since 2026-09-22` keeps only records from that time on, and `--project <text>` keeps only sessions whose project folder contains the text. Records from before 2026-09-22 have no project folder, so a project filter drops them.

What it prints, and what each number is for:

- Dispatches per project, mode and action, and the share that the hook changed, by reason. This is the first number to read: when it is near zero, the plugin costs TypeSafe latency and money and saves nothing.
- How often the orchestrator named a model in the call, and how often the hook ran another one, down or up, by pair (`opus->sonnet`), plus how often shadow mode would have done so. A move to or from a Codex worker is counted apart, because Haiku only runs the Codex wrapper and Codex does the task with its own model. Jev sees only the brief, and the orchestrator sees the whole conversation, so a high count downwards is the question to ask before trusting the table over the orchestrator.
- Jev: how often it answered, its latency, the kinds, the share of answers at the kind gate and at the difficulty gate, and how often it agreed with the request, differed, or abstained.
- Labels for a route that was too small, which the log gives for free: a retry of the same brief in the same session on a bigger model; a worker result whose verification text names a failure (a text match, because workers write the verification in their own words); a Codex job that failed. The other direction, a route that was bigger than needed, cannot come from the log; it needs the offline task set of the evaluation step.
- Durations per worker from start to stop, and review findings by the family of the author, with the same author rule as the cross-review: a worker that failed or reported "Changed files: none" is not an author.
- Claude usage over time from the status line log: the range of each window, how many windows were seen, and for each sample whether it was at the gate, tight by pace only, or calm.

A `session` line is written at each session start, with `source` (`startup`, `resume`, `clear` or `compact`) and the configuration in force. A `dispatch` line has `claude` (whether Claude counted as tight, the reason `gate` or `pace`, and the projection of each window), `requested` (what the orchestrator asked for), `jev` (the answers, the model version and the time of the call), `route` (what the table said), `final` (what ran) and `action`: `rewrite`, `agree`, `pass`, `shadow`, `redirect`, `fallback` or `deny`. A `stop` line of a reviewer has `findings`, a count per priority.

### The offline evaluation

Executable checks are available for code-editing evaluations. Set `export: true` and add `verify: { "script": "../checks/check.mjs", "timeoutS": 30 }` to a task. The script path is relative to the task-set file. It must be outside the source tree named by `cwd`. Treat task sets and graders as trusted programs: never run a grader supplied by an issue or by the worker.

The runner copies the single `.mjs` grader before starting the worker. Its only argument is the path of the finished code snapshot. Use Node built-in modules; sibling helper files are not copied. Exit 0 means pass; another exit code or a timeout means failure. The grader should assert the required behavior itself. If it runs candidate code, run that code in a child process and check the result in the trusted parent. Importing candidate code into the grader lets that code terminate or change the grader itself.

These tasks require an empty output folder. Each trial exports the committed tree, leaving the source checkout untouched. On macOS, the entire worker runs under Seatbelt through `/usr/bin/sandbox-exec`. On Linux it needs a working bubblewrap installation at `/usr/bin/bwrap` or `/bin/bwrap`. The runner installs nothing. A missing or unusable boundary stops the run before the worker starts; it never falls back to an unrestricted process. Other operating systems cannot run executable evaluations yet.

On Ubuntu 24.04, installing bubblewrap alone may not allow it to create namespaces. An administrator must also install `apparmor-profiles` and load its `bwrap-userns-restrict` profile. Check existing AppArmor profiles before adding another profile for the same executable. CI installs the supplied profile on its disposable runner and checks namespace startup before testing containment. See [Ubuntu's explanation of per-application namespace permissions](https://ubuntu.com/blog/ubuntu-23-10-restricted-unprivileged-user-namespaces).

The worker can write only its exported workspace, router data folder and private temporary folder. The copied grader, evidence folder and original grader file are hidden from its reads. Other reads and network remain available for the provider and project tools. This is not protection against all disclosure by an authenticated agent. The grader has no network, receives no inherited credentials and can write only its own temporary folder. It reads the protected snapshot, grader and runtime files. Snapshots reject links and special files, and stop above 100 MiB or 10,000 entries. Snapshot copying also runs inside a boundary so path races cannot read unrelated host files. Each exported task uses one pinned source revision across all arms and trials; records include `source_revision`.

Run `npm run test:boundaries` on a host that supports the sandbox. It requires successful confinement and fails if the backend cannot start. CI runs it on macOS and Linux. The general test suite also checks refusal on hosts that cannot start a nested sandbox.

The runner saves each trial's controls under `<output>/verification/grade-*/` and includes the evidence in `runs.jsonl`. Every worker is denied the entire verification root, including earlier and later trials, plus all original grader scripts in this task set. This does not hide other archived copies or git history elsewhere on the host. Evidence records the grader hash, code hash, command, exit code, duration, timeout and boundary backend. Grader output is represented by a hash, not saved verbatim, to avoid retaining secrets. Status is `passed`, `failed`, `stale` or `error`. A worker's claim that tests passed cannot replace this evidence. Hashes identify content; they are not signatures against someone who can edit the result files outside the worker.

`--regrade` never executes the grader again. It checks the current workspace and grader against the saved hashes. Missing, changed or unavailable evidence cannot pass. Failed executable evaluations count as failures even when the worker crashes, unlike the older text-only grading. Keep the saved workspace to revalidate results. A changed grader needs a fresh trial. Executable failure makes a live evaluation exit 1. Regrading reports grade failures in its summary; its exit code 0 means the records were read successfully. Ordinary evaluations without `verify` keep their existing behavior and do not gain this OS boundary.

Codex jobs also receive explicit command-line execution settings: reviews use `read-only`, implementations use `workspace-write`, approval escalation is disabled, command networking is disabled, and extra writable roots and shared temporary roots are removed. These settings rely on the installed Codex CLI's sandbox enforcement. They do not restrict the main Claude session or every external tool. Implementation checks that need network access or shared temporary writes now fail visibly instead of inheriting permissive user defaults.

The log shows where the hook changed a route. It cannot show whether the other route would have been better, because only the chosen worker ran. For that question the same task must run several ways. The runner does that, grades each result and saves the numbers.

```bash
node scripts/orch-eval.mjs examples/eval-tasks.json --dry-run
node scripts/orch-eval.mjs <task set.json> --arms off,sonnet,shadow,jev --runs 3 --max-total-usd 5
```

A task set is a JSON file with a `tasks` list. Each task has a `name`, a `prompt` and a `cwd` (the project folder), and may set `model` (the main session's model, default `sonnet`), `budgetUsd` (the cap of one run, default 1), `timeoutS` (default 600), `allowedTools` (default `Read`, `Glob`, `Grep`, `Agent`) and `export` (run in a fresh copy of the committed tree, for a task that writes files). The file may set the same fields as defaults for all its tasks. `examples/eval-tasks.json` is a sample.

Alongside `verify`, two fields grade saved text and routing. `expect` holds `contains` and `notContains`, lists of strings that the answer must or must not hold. `expectRoute` holds `agent` and `model`, the expected route; only an arm in enforce mode is graded by it. A run passes when every applicable grader passes. Text-only tasks leave worker errors and timeouts ungraded. Executable tasks count them as failures.

Text expectations can be changed and applied to saved records without another model call. Executable evidence is revalidated against the saved workspace and original grader; changing the executable grader requires a fresh trial:

```bash
node scripts/orch-eval.mjs <task set.json> --regrade ~/.claude/orchestrator/eval/<time>/
```

The arms: `off` is Claude Code without the plugin; `sonnet` is without the plugin with every subagent forced to Sonnet, the baseline to beat; `shadow` loads the plugin in shadow mode, so its workers and skills exist and the hook changes nothing; `jev` loads the plugin in enforce mode. Two more arms run only when `--arms` names them: `low` and `medium` run without the plugin, with the whole session at that effort (effort is how much the model thinks before it answers). They are the single-model baselines: Anthropic measured that one model at a lower effort often costs less than a setup with several models. The shell's `CLAUDE_CODE_EFFORT_LEVEL` and `CLAUDE_EFFORT` never reach an arm, so each arm runs at the effort it names, or at the model's default. Every run counts against the Claude plan, so the command prints the plan and the most it can spend before it starts, and `--dry-run` stops there. Each run gets its own data folder, so the real store stays clean, and the run has no usage sample, so the limit rule and the pace rule stay off. `--config <file>` gives the plugin arms a copy of a config file; without it the defaults apply, with Codex off. The `shadow` and `jev` arms turn Jev on for themselves, and they read the key from `TYPESAFE_API_KEY` in the shell that starts the runner.

At the end the command applies the pass rule per task: the `jev` arm must cost less than the `sonnet` baseline at the same pass rate or better, and every route it took must be the expected one. The verdict is `NOT DECIDED` instead of a number when fewer than three scored runs per arm exist, when the two arms wrote very different amounts into the prompt cache (a factor above two), when no grader ran, or when the gap between the two arms is narrower than the uncertainty of that gap (twice its standard error). That last guard eases as runs are added, so paying for more runs buys a sharper answer. A wrong answer or a wrong route still fails at once, because those are not matters of degree. That is deliberate: a cost difference under those conditions is noise, not a result.

When `low` or `medium` ran next to `jev`, the summary also sets `jev` against each of them, under the same guards. This is information, not part of the pass rule: it says whether a plain session at lower effort reaches the same pass rate for less than the routing does.

The arms of a run start at a different arm each time, so no arm always runs on the coldest prompt cache. Read the column "cache new" before the cost: a run that wrote many tokens into the prompt cache costs more for that reason alone, whatever the route did. Use at least three runs per arm before you read a cost difference as a result.

The results go to `~/.claude/orchestrator/eval/<time>/` (or `--out`): `runs.jsonl` with one line per run (cost, turns, durations, the models that ran, the number of refused tool calls, the dispatches of the plugin's hook with the model that then ran, and the answer cut to `--result-chars`), and `summary.json` with the counts per task and arm. The text summary prints counts only; no prompt and no answer reaches it. A failed or timed-out run also keeps the last 2,000 characters of its error output in `runs.jsonl`, not redacted, so treat that file as private output of the run. Exit code 1 means an error or a timeout in some run, 3 means `--max-total-usd` stopped the command.

`model_only: true` marks a dispatch to another agent type that the table read. There the table can name only a model. A call to another agent type that the hook leaves alone has no such mark. Its `reason` is `keep_model_agent` when the agent type is on the keep list or is a fixed helper of Claude Code, and `other_agent_type` when `routeOtherAgents` is `false`. A brief with `orch-route: keep` gives the reason `keep_requested`.

## Long Codex runs

A Codex task can run longer than the 10-minute maximum of the Bash tool. So `scripts/orch-codex.mjs` starts Codex as a detached process and waits up to 9 minutes. If Codex needs longer, the command prints `STILL_RUNNING` and the exact `wait` command, and the worker runs that command until the result is there.

```bash
node scripts/orch-codex.mjs wait <job id>
```

```bash
node scripts/orch-codex.mjs cancel <job id>
```

What happens when something goes wrong:

- Codex runs in its own process group, with the commands that it starts. `cancel`, a timeout and the normal end all stop the whole group before the folder is free. A command that leaves the group on purpose (with `setsid`) is not covered.
- `cancel` stops the runner and Codex, and reports success (`CODEX_CANCELLED <job id>`) only after both are gone. The job then ends with the exit code 143. A cancel is not a failure, so the report does not count it as a failed Codex job.
- If `ps` cannot tell whether a process belongs to the job, `cancel` stops nothing and keeps the writer lock. It answers `CODEX_FAILED <job id> cancel_failed`. Run it again.
- If the runner and Codex are both gone without an exit code, `wait` reports `CODEX_FAILED <job id> runner_died`, with the output of the runner from `runner.log`. The folder is free again.
- If only the runner died, Codex may still change files. The job stays active, the folder stays locked, and `wait` names the `cancel` command.
- A job that runs longer than 120 minutes is stopped with the exit code 124.
- An error inside the runner after Codex has started, for example a file that cannot be written, stops Codex first. The exit code appears only when Codex has ended, and the folder stays locked until then.
- A `run` that the writer lock refuses (`writer_busy`) gives the request back. The same `run` command works again once the other job has ended. When the lock cannot be read, the message names no job but the lock file; such a lock stops counting 15 minutes after it was written.
- When Codex fails, the first line of the reason is what Codex itself reported, for example a used-up plan. Codex prints that as a JSON event, not as error output.
- After 6 waits of 9 minutes, the worker hands the `STILL_RUNNING` text back to the main session.

## Known limits

- The writer lock covers Codex jobs and the plugin's Claude writers. It does not cover edits by the main session, or agent types of other owners: such an agent waits for a writer when Jev says that its task changes files, but it takes no lock itself.
- A Claude writer's lock that no subagent has confirmed stops counting after 30 seconds, for a dispatch that was refused or never started. A confirmed lock counts until its subagent stops, its session ends, or one hour has passed. A writer that runs longer than one hour is not protected any more. When the lock is stuck, the denial names its file; remove it only when you are sure that no writer runs.
- An agent type of another owner waits for a Codex writer only when Jev answered and said that its task changes files. When Jev is not asked (`routeOtherAgents` is false, or the type is on the keep list) or fails, the call runs.
- The hook redirects `codex:codex-rescue` to `subagent-router:codex-implementer`. This closes one known way around the routing, not all of them. It also changes what `/codex:rescue` does. Use `ORCH_MODE=off` to get the old behaviour.
- Codex reports zero tokens for a review run, so the log has no token count for reviews.
- The hook learns the Codex limit numbers only after a Codex job that the plugin started. The numbers come from Codex's own session file, where Codex records each run. The format of that file is internal to Codex, not a public interface, so a Codex update can change it. A job that fails with a usage limit also pauses Codex until the time that Codex named. Between two jobs the numbers can be out of date. Then a job can still spend Codex credits, even when `codexSpendCredits` is `false`.
- The routing table and the gates are first guesses. The log shows where Jev and the orchestrator disagree. It cannot show which route would have been better. That needs the same tasks with routing on and off.
- For another agent type, Jev sees only the brief and never the agent file. It cannot know why an agent file names a model. Use `keepModelAgents` for an agent that must keep its model.
- For another agent type, the hook does not read the agent file. So the log cannot tell whether a rewrite changed the model that would have run. When the agent file already names the model of the table, the log still says `rewrite`. In `shadow` mode the `launched` line shows the model that runs without a rewrite.
- The upper limit of Sonnet covers only routes that the table picks, and only while Codex cannot take work. While Codex can take work, a hard task for another agent type still runs on Opus at a high Claude usage, because such a call cannot move to Codex.

## Tests

```bash
npm test
```

The tests need no network and no key. They use a local stand-in for the TypeSafe API and a stand-in for the `codex` command. There are no npm dependencies.
