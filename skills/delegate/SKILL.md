---
name: delegate
description: Brief and result formats for the subagent-router workers, and the rules for when to delegate. Use before you hand a task to a subagent-router worker (searcher, implementer, debugger, reviewer, codex-implementer, codex-reviewer).
---

# Delegate work to a subagent-router worker

## When to delegate

- Delegate a task only when it is large enough. Each dispatch costs tens of thousands of tokens before any work happens. Do small tasks in the main session.
- Run only one worker that changes files at a time. All workers share one working tree.
- Do not start a writer while a review of uncommitted changes runs. The review must see a stable state.
- While another writer still changes files in the checkout, the hook denies a new writer or reviewer. The other writer is a Codex job or a Claude writer (implementer, debugger). For a Codex job, the denial names the command to wait for the job and the command to cancel it. For a Claude writer, wait until its subagent has finished. Send one writer at a time: of two writers in one message, the second is denied.

## The brief

A worker starts with no memory of this conversation. Codex starts with no context at all. Write every brief so that it stands alone.

```
Goal: <what must be true when the task is done, in one or two sentences>
Files: <the paths to read and the paths to change>
Constraints: <what must not change, which patterns to follow, which libraries not to add>
Verify: <the exact command that shows success, and the expected result>
Output: <what the worker must report back>
```

What a brief adds for some tasks:

- **Every change and every review:** `Base: <commit>`, the commit that the change starts from. A Claude reviewer diffs against it and never guesses `HEAD~1`. A Codex reviewer reads the `Base:` line only with `review-scope: custom`; with the other scopes Codex picks the diff itself.
- **Debugging:** the symptom exactly as it was seen; what the worker may change (`Writes: none`, `Writes: tests only` or `Writes: fix allowed`); and a budget in tool calls for the whole task. A debug task that changes files can be routed to the Codex implementer, which never reads the debugger's instructions. So add this text to such a brief: "Before any change, write the test that you keep so that it fails on this exact bug, and watch it fail; that run is the old-code check. Never undo your fix in the working tree. A cause is confirmed only when changing it makes that test pass or fail. Accept a fix only when the test passes, related tests still pass, and the fix does not skip or drop any part of the reported input. After 3 failed fixes, stop, restore the files and report. Put the runs that failed before the fix on a `Reproduction:` line after Open problems, then a `Cause:` line marked confirmed or unconfirmed. The Verification line holds only the final result."
- **Review:** never tell the reviewer what not to report. Present the author's own account as claims to check. Put a list of known issues at the end, marked as known, without priority tags. For a Codex review with `review-scope: custom` that checks rules or smells, ask for the `(rule: <file>)` and `(judgement)` labels in the brief. A Codex review with another scope never reads the brief, so it cannot see a known list.

Optional lines for Codex workers:

```
codex-model: <model name>
codex-effort: <none | minimal | low | medium | high | xhigh>
review-scope: <uncommitted | base:<branch> | commit:<hash> | custom>
```

Codex refuses review instructions together with a scope. With `uncommitted`, `base:` and `commit:`, Codex reviews that diff with its own rules and does not read the brief. With `custom`, Codex reads the brief as its instructions, so the brief must name what to review. Codex then returns its whole answer, in the answer format that the brief names, with each finding tagged `[P0]` to `[P3]`.

A direct call to `subagent-router:codex-reviewer` without a scope line reviews the uncommitted changes, and the brief is not read. Write `review-scope:` when you mean something else. When the routing hook moves a review brief from `subagent-router:reviewer` to Codex, it uses `custom`, so the brief is not lost.

Optional line for every agent type:

```
orch-route: keep
```

With this line the routing hook runs the dispatch exactly as written: the same agent type and the same model. Use it for a retry. When a worker was blocked on a small model, start the same brief again on a bigger model and add this line. Without it, the hook reads the same brief again and picks the small model again.

## The result

Every worker answers with these three parts. Keep the result out of the main context when it is long: ask for a summary, not for file contents.

```
Changed files: <list of paths, or "none">
Verification: <the command that ran and its result, or "not run" with the reason>
Open problems: <list, or "none">
```

Reviewers add findings in this form, the most serious first:

```
- [P1] <short title>: <path>:<line>
  <what goes wrong, and with which input>
```

Both reviewer families use one scale: P0 breaks the build or loses data, P1 is a bug that users will hit, P2 is a bug in a rare case, P3 is a minor problem.

When a review brief asks for documented rules or code smells, the title carries `(rule: <file>)` for a broken documented rule and `(judgement)` for a smell. The priority says how bad the problem is; the label says what kind of evidence stands behind it. A finding that is already on the brief's list of known issues comes under `Known:` without a priority tag, so it is not counted again.

The debugger adds two lines: `Reproduction:` with the failing command, and `Cause:` marked `confirmed` or `unconfirmed`. Treat an unconfirmed cause as a lead, not as a result. A debug result without a `Cause:` line, for example from Codex, counts as unconfirmed.

## Review

Codex is opt-in. While it is off, the session start text says so, and every review goes to `subagent-router:reviewer`.

- Review once per logical piece of work, not after every edit.
- For a full review of a branch, a pull request or the uncommitted work, use the skill `subagent-router:review`. It reviews Standards, Spec and Correctness separately and reports them side by side.
- The reviewer comes from the other model family than the author. Changes from Claude workers or from the main session go to `subagent-router:codex-reviewer`. Changes from `subagent-router:codex-implementer` go to `subagent-router:reviewer`.
- A call to a Codex worker stays on Codex while Codex can take it. The hook moves it to Claude only when Codex is off, paused, used up, or near its limit while Claude is not, and moves a review to the Claude reviewer when Codex wrote the change.
- A finding can be wrong. Check it against the code before you act on it.
- A clean review is not proof that the change is correct.

## The routing hook

A hook asks the Jev classifier about each dispatch. When Jev is confident, the hook can change the worker or the model of a dispatch to these workers. The tool result then says which worker ran.

For every other agent type, such as a built-in agent or a project's own agent, the hook can change only the model. The agent type stays, with its system prompt, its tools and its answer format. So keep using a project's own agents where a project skill names them. The session start text says when this part is off.
