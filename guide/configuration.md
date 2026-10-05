# Configuration

Part of the [Subagent Router documentation](../README.md#documentation).

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

## Routing

| Key | Default | Meaning |
| :-- | :-- | :-- |
| `mode` | `enforce` | `enforce`, `shadow` or `off`. See [Modes](routing.md#modes). |
| `kindGate` | `0.6` | The confidence that Jev needs in the kind of task before the hook rewrites a call. |
| `difficultyGate` | `0.5` | The confidence that Jev needs in the difficulty before the difficulty counts. Below it, the task takes the normal route for its kind. |
| `selfContainedGate` | `0.7` | How self-contained a brief must be before Codex gets the task. |
| `routeOtherAgents` | `true` | Let the hook set the model of a call to an agent type that is not one of the plugin's workers. |
| `keepModelAgents` | `[]` | Agent types from outside the plugin whose model the hook never changes, by exact name, for example `["spec-compliance-reviewer"]`. Their briefs are not sent to Jev. Names of the plugin's own workers and `codex:codex-rescue` have no effect. |

## Usage limits

| Key | Default | Meaning |
| :-- | :-- | :-- |
| `limitGate` | `80` | The usage percentage from which a plan counts as near its limit. For Claude, it applies to the 5-hour and the weekly window. The table then prefers Codex while Codex is not near its own limit, and caps routes at Sonnet when Codex cannot take work. For Codex, it applies to its saved plan usage. The table then keeps hard implementations and direct Codex implementer calls on Claude while Claude is not near its limit. |
| `pacing` | `true` | Also count a window as near its limit when the usage so far, at the same speed, would reach 100 percent before the reset. |
| `paceAfter` | `0.2` | How much of a window must pass before the pace rule counts, from 0 to 1. |
| `limitsMaxAgeMs` | `600000` | How long a usage sample stays usable, in milliseconds. Older samples are ignored, and the limit rules stay off. |

## Answer completeness

| Key | Default | Meaning |
| :-- | :-- | :-- |
| `completeRule` | `shadow` | What to do with a search that is only answered correctly by a complete list: `shadow`, `enforce` or `off`. |
| `completeGate` | `0.6` | How sure Jev must be that the answer needs every match before the rule counts, from 0 to 1. |

The values of `completeRule`:

- `shadow` changes no route. It records what it would have changed.
- `enforce` sends such a search to `complete-searcher` (Sonnet at effort `low`) instead of `searcher` on Haiku. For other agent types, such as `Explore`, it can change only the model, to Sonnet.
- `off` does neither.
- A search that the main session itself sends to `complete-searcher` stays there, whatever the value.

## Codex settings

| Key | Default | Meaning |
| :-- | :-- | :-- |
| `codexEnabled` | `false` | Let the plugin use Codex at all. While this is off, no task reaches Codex in any mode. |
| `codexSpendCredits` | `false` | Let a Codex job spend bought credits once a Codex plan window, the 5-hour or the weekly one, reaches 100 percent. It also lets the Codex runner start a job during the pause after a usage limit. See [Credits and pauses](codex.md#credits-and-pauses). |
| `codexIncludeUserRules` | `true` | Send `~/.claude/CLAUDE.md`, the files under `~/.claude/rules/` and their allowed imports with implement, custom review and consult briefs. |
| `codexIncludeProjectRules` | `true` | Send the `CLAUDE.md` files of the project and its parent folders, the `CLAUDE.local.md` files, the project rules and their allowed imports with implement, custom review and consult briefs. |

## Classifier and log

| Key | Default | Meaning |
| :-- | :-- | :-- |
| `jevEnabled` | `false` | Let the hooks send briefs, and the verification part of worker answers, to Jev. The routing needs it. See [TypeSafe and Jev](jev.md#typesafe-and-jev). |
| `jevModel` | `jev-latest` | The classifier version. Pin an exact version while you measure, so that a new Jev version cannot change the routing during the measurement. |
| `jevUrl` | the TypeSafe endpoint | Where the classifier request goes. |
| `jevTimeoutMs` | `5000` | How long to wait for an answer, from 100 to 8000. On a timeout, the call runs as written. |
| `promptLogChars` | `20000` | How much of a brief the log keeps. `0` keeps briefs out of the log entirely. |
| `resultLogChars` | `4000` | How much of a worker's answer the log keeps. |

## Finding triage

These settings turn on the [finding triage](finding-triage.md). What it sends is listed in [What leaves your machine](privacy.md).

| Key | Default | Meaning |
| :-- | :-- | :-- |
| `triageMode` | `off` | `log` turns the triage on. It needs `jevEnabled` too. |
| `triageProjects` | `[]` | The checkout roots, as absolute paths, for which the triage may send findings and excerpts. A path counts only when it is exactly the root of the session's git checkout. `orch-config.mjs set` refuses a path that does not exist, is not in git, or is a folder below the root (it names the root), and it stores the real path, so a symbolic link cannot move later. Write a JSON list, or paths split by commas. Empty sends nothing. |
| `triageWorktrees` | `false` | `true` lets each checkout in `triageProjects` also cover every worktree of the same repository, including worktrees made later. The match is exact, never a path prefix: the same git common directory (the shared `.git` folder that all worktrees of one repository use), and git must list the folder as one of that checkout's worktrees. With `false`, a second worktree has its own root and needs its own entry. |
| `reviewFormats` | `[]` | Which agent types report findings with which labels, for example `[{"agentTypes":["my-reviewer"],"labels":["BLOCKING","SUGGESTION"],"emptyPhrases":["no findings"]}]`. The plugin's own reviewers and Codex reviews use `[P0]` to `[P3]` and need no entry. |

## Settings for one session

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

The files in the data folder are listed in [The data folder](report-and-log.md#the-data-folder).
