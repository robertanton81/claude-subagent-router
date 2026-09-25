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

Optional lines for Codex workers:

```
codex-model: <model name>
codex-effort: <none | minimal | low | medium | high | xhigh>
review-scope: <uncommitted | base:<branch> | commit:<hash> | custom>
```

Codex refuses review instructions together with a scope. With `uncommitted`, `base:` and `commit:`, Codex reviews that diff with its own rules and does not read the brief. With `custom`, Codex reads the brief as its instructions, so the brief must name what to review.

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
- [P1] <short title> — <path>:<line>
  <what goes wrong, and with which input>
```

## Review

Codex is opt-in. While it is off, the session start text says so, and every review goes to `subagent-router:reviewer`.

- Review once per logical piece of work, not after every edit.
- The reviewer comes from the other model family than the author. Changes from Claude workers or from the main session go to `subagent-router:codex-reviewer`. Changes from `subagent-router:codex-implementer` go to `subagent-router:reviewer`.
- A call to a Codex worker stays on Codex while Codex can take it. The hook moves it to Claude only when Codex is off, paused, used up, or near its limit while Claude is not, and moves a review to the Claude reviewer when Codex wrote the change.
- A finding can be wrong. Check it against the code before you act on it.
- A clean review is not proof that the change is correct.

## The routing hook

A hook asks the Jev classifier about each dispatch. When Jev is confident, the hook can change the worker or the model of a dispatch to these workers. The tool result then says which worker ran.

For every other agent type, such as a built-in agent or a project's own agent, the hook can change only the model. The agent type stays, with its system prompt, its tools and its answer format. So keep using a project's own agents where a project skill names them. The session start text says when this part is off.
