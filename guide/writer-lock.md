# The writer lock

Part of the [Subagent Router documentation](../README.md#documentation).

The writer lock is the one case in which the routing hook refuses a call on purpose.

In `enforce` mode, the routing hook stops two writers from changing the same checkout at the same time. A writer is a task that changes files. A checkout is one git working tree: the project folder with everything below it. So a writer in `repo/src` and a writer in `repo` use the same checkout. A second working tree that you create with `git worktree add` is a checkout of its own.

**Who takes the lock:**

- A Codex implement job. The lock names the job and the process that started it, so it holds from the start, before the Codex runner has written its process id. Reviews and consults take no lock.
- The plugin's Claude writers, `implementer` and `debugger`, that run as subagents. A Claude writer takes the lock when the hook lets it through. So of two Claude writers sent in one message, only the first runs.

A Codex implement job takes the lock only when the job starts, some time after its hook ran. So when a Codex writer and a Claude writer are sent in one message, the Claude writer can take the lock first, even when it was sent second. The Codex job then fails with `writer_busy`.

**What the hook denies while another writer holds the lock:**

- A call to one of the plugin's writers or reviewers.
- A call to another agent type, such as `general-purpose`, when Jev says that its task changes files. Such a call takes no lock itself. When Jev is off, fails, or is not asked, the hook cannot know that the call writes, so it lets the call run. Jev is not asked when the call comes from inside a subagent, when `routeOtherAgents` is false, when the agent type is `statusline-setup`, `claude-code-guide` or on the list `keepModelAgents`, or for a call to `codex:codex-rescue` while Codex is off.
- The log names the denial `codex_writer_busy` or `claude_writer_busy`.

**How long a lock counts:**

- A Claude writer's lock that no subagent has confirmed stops counting after 30 seconds. This covers a dispatch that was refused or never started.
- A confirmed lock counts until its subagent stops, or until one hour has passed. A writer that runs longer than one hour is not protected any more.
- The end of the session's Claude Code process does not end the lock. When you move a session to the background (the left arrow, `/bg`, or "Move to background and exit"), or the supervisor (the Claude Code process that runs background sessions) restarts it, Claude Code starts a new process for the session. A running subagent goes on in that process, and its stop there gives the lock back. In versions 0.3.2 to 0.4.0 the lock ended as soon as the recorded process had ended, so from that moment a second writer could start while the first one still changed files.
- The cost of this rule: after a real crash, when no new process takes the subagent over, the lock blocks other writers for up to one hour.
- A lock file that cannot be read stops counting 15 minutes after it was written.
- When a lock is stuck, the denial names its file in `~/.claude/orchestrator/locks/`. Remove the file only when you are sure that no writer runs: check that no subagent of that session is still running, for example in `/tasks` of the session or in `claude agents`.

The lock does not cover edits by the main session.
