# How the routing works

Part of the [Subagent Router documentation](../README.md#documentation).

1. The main session hands work to subagents: the plugin's seven workers, or any other agent type. The report calls the main session the orchestrator.
2. The plugin's routing hook, a script that Claude Code runs at a fixed event, runs before each call of the `Agent` tool. It never sees agents that the Workflow tool starts; see [Calls the hook leaves alone](#calls-the-hook-leaves-alone).
3. While Jev is on, the routing hook sends the brief to Jev and gets answers to [five questions](jev.md#what-jev-is-asked) about the task.
4. A table in code turns the answers into a route. For a call to one of the plugin's workers, the route is a worker and a model. For a call to any other agent type, the route is only a model.
5. When Jev is confident, the hook rewrites the call. When Jev is not confident, the call runs as the main session wrote it.
6. The hook writes every dispatch (one subagent call) to the dispatch log, with the main session's choice next to the table's route.

## The workers

The seven workers and their models are listed under [The workers](../README.md#the-workers) in the README. Their effort is under [Effort](#effort) below.

Effort is how much the model thinks before it answers. Each worker sets it in its agent file, so the effort of your session does not carry over; see [Effort](#effort).

When the main session calls one of these workers by name, the table still routes the task like any other task. The name counts only for `complete-searcher` and the two Codex workers. So while Codex is on, a direct call to `implementer`, `debugger` or `reviewer` can move to Codex, and a direct call can get another model, for example Opus for a hard task. See [Direct calls to the plugin's workers](#direct-calls-to-the-plugins-workers).

**The cross-review rule.** While Jev is on, a review goes to the other model family than the one that wrote the change:

- The Claude reviewer reviews a change that Codex wrote.
- Codex reviews a change that Claude wrote, when Codex can take work and the review brief is self-contained (`selfContainedGate`). A direct call to the Codex reviewer also goes to Codex, even when its brief is not self-contained.
- Otherwise, the Claude reviewer reviews the Claude change.

## Other agent types

Other agent types are the built-in agents (`Explore`, `Plan`, `general-purpose`), a project's own agents, and the agents of other plugins. Many projects start such agents from their own skills, for example a plan skill that starts a plan reviewer. For these calls, the plugin picks only the model:

- The hook sets `model` and does not change `subagent_type`. So the agent keeps its system prompt, its tools, its preloaded skills and its answer format. A project skill often reads that answer in a fixed format, and a swap to one of the plugin's workers would break it. The one exception is `codex:codex-rescue`; see [Codex](codex.md#codex).
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

## Modes

| Mode | What the routing hook does |
| :-- | :-- |
| `enforce` (default) | Asks Jev, while Jev is on, and rewrites confident routes. Moves a task for a Codex worker to Claude while Codex cannot take work. Applies the writer lock. |
| `shadow` | Asks Jev, while Jev is on, and logs the route that it would take. Changes no route. |
| `off` | Logs the dispatch. Does not ask Jev. |

While Codex is on, the Codex workers can reach Codex in every mode. Set the mode in [the settings file](configuration.md#configuration), or for one session with `ORCH_MODE=shadow claude ...`.

## Lines that a brief can carry

| Line | Effect |
| :-- | :-- |
| `codex-model: <name>` | The Codex model for this task. |
| `codex-effort: <none, minimal, low, medium, high, xhigh>` | The reasoning effort of Codex. |
| `review-scope: uncommitted` | Review the uncommitted changes. This is the default for a direct call to the Codex reviewer. |
| `review-scope: base:<branch>` or `commit:<hash>` | Review against a branch, or review one commit. |
| `review-scope: custom` | Send the brief to Codex as review instructions. Codex returns its whole answer. See [Codex reviews](codex.md#codex-reviews). |
| `orch-route: keep` | The hook runs this call as written: the same agent type and the same model. It works for every agent type except `codex:codex-rescue`. |

A Codex line that is present but not valid, for example `review-scope: branch:main`, stops the task with `CODEX_FAILED`. It never falls back in silence, because Codex would then review a different diff than the one you asked for.

**`orch-route: keep` is for a retry.** Jev sees only the brief. When a worker was blocked on a small model and the same brief starts again on a bigger one, Jev would pick the small model again. With this line, the retry stays on its model.

- Jev is still asked, so the log shows what the table would have picked.
- `orch-route: keep` must be the only text on its line. Any other value is ignored, and the log reports it in `brief_warnings`.
- It does not stop three things: the redirect of `codex:codex-rescue`, the move of a Codex task to Claude while Codex cannot take work, and the writer lock.
- It does keep a model above Sonnet while Claude is near its limit.

## Calls the hook leaves alone

In these cases the routing hook does not route the call: the agent type and the model stay as the main session wrote them. The `reason` in the log names the case. Two things can still apply afterwards: the move of a Codex task to Claude while Codex cannot take work, and the [writer lock](writer-lock.md#the-writer-lock).

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

The hook never sees an agent that the Workflow tool starts, so such an agent has no dispatch record and no `reason`. A workflow script starts its agents without the `Agent` tool, and the hook runs only before that tool. The agent runs on the model that the script names, it takes no [writer lock](writer-lock.md#the-writer-lock), and a Codex worker gets no request line, so it stops with `CODEX_FAILED no codex-request line`. The log hook still records the agent's start and stop.

## Direct calls to the plugin's workers

When the main session calls one of the plugin's workers by name, the table still routes the task like any other task of its kind. The name counts only for three workers:

- A search that the main session sends to `complete-searcher` stays there, whatever the value of `completeRule`.
- A task sent to `codex-implementer` stays on Codex while Codex can take work. It moves when Codex is near its own limit and Claude is not. It also moves when Jev reads the task as a search, a review, or a diagnosis that changes no files. The table then routes it like any other task: a search goes to `searcher`, a diagnosis to `debugger`, and a review follows the cross-review rule. That rule sends a review to the other model family than the one that wrote the change, so it can still go to the Codex reviewer.
- A review sent to `codex-reviewer` stays on Codex while Codex can take work, unless Codex wrote the change. A task that Jev reads as something other than a review is routed like any other task. For example, a task read as an implementation goes to an implementer.

A direct call to `implementer`, `debugger` or `reviewer` gets no such rule. So while Codex is on, a hard, self-contained implementation sent to `implementer` moves to Codex, and a self-contained review of a Claude change sent to `reviewer` moves to the Codex reviewer. A direct call can also get another model, for example Opus for a hard task.

## Effort

Effort is how much the model thinks before it answers.

- Each Claude worker sets its effort in its agent file. So the effort of your session does not carry over to the workers.
- Most workers use the default of their model: Sonnet 5 `high`, Opus 5.5 `medium`. The complete searcher is the exception: it runs Sonnet at `low`.
- Haiku 4.5 takes no effort setting.
- The level stays when the hook changes the model. An implementer moved to Opus runs at `high`.
- The variable `CLAUDE_CODE_EFFORT_LEVEL` overrides the level.
- The Codex workers use the model and effort of `~/.codex/config.toml`, unless the brief has a `codex-model:` or `codex-effort:` line.

## Safety rules

**The hook fails open:** when something goes wrong, it lets the call run instead of blocking it. When the Jev call fails or the hook finds no key, the hook does not route the call. When the hook itself fails with an error, it prints nothing, and the call runs as the main session wrote it. The Jev timeout is `jevTimeoutMs`, 5 seconds by default. An error text from TypeSafe has the key removed before it is stored.

**The [writer lock](writer-lock.md)** is the one case in which the hook refuses a call on purpose.
