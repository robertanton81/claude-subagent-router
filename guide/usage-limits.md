# When a plan is near its limit

Part of the [Subagent Router documentation](../README.md#documentation).

Three states decide these rules:

- **Claude is near its limit** when its 5-hour window or its weekly window is at `limitGate` (80 percent) or more, or when the pace rule below counts the window. This needs the [status line log](setup.md#add-the-status-line-log-optional).
- **Codex cannot take work** while it is off, while it is paused after a usage limit, or while its saved plan numbers show a window at 100 percent and `codexSpendCredits` is false.
- **Codex is near its limit** when the plan numbers that an earlier Codex job saved are at `limitGate` or more.

In short:

| Situation | What happens |
| :-- | :-- |
| Codex cannot take work | In `enforce` mode, tasks for the Codex workers run on Claude workers. |
| Claude is near its limit, Codex can take work, and Codex is not near its limit | Implementations, most edits, and debug tasks that change files go to Codex, when their brief is self-contained. Searches, reviews and diagnoses keep their route. |
| Claude is near its limit, and Codex cannot take work | The hook lowers every route that it picks from Opus to Sonnet. A call that the hook leaves alone keeps its model, even Opus. |
| Codex is near its limit, and Claude is not | Hard implementations run on Claude, on Opus. A direct call to the Codex implementer is no longer kept on Codex. |
| Both are near their limits, and Codex can take work | Every task takes its normal route. |
| Claude is used up | The main session stops. Go on in Codex by hand. |

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
