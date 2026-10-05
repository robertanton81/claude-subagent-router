# Claude Subagent Router

A Claude Code plugin with seven subagent workers and a review skill that checks rules, the spec and bugs separately. A subagent is a helper that your main Claude Code session starts for one task. The main session gives it a brief: the prompt that describes the task. Five workers run on Claude models. Two hand their task to the Codex CLI, OpenAI's coding agent for the terminal, once you turn Codex on.

Two parts are optional and off by default:

- **Codex** runs tasks on your ChatGPT plan. The plugin blocks bought Codex credits unless you allow them, with one exception under [Known limits](#known-limits).
- **Model routing** sends the briefs of `Agent` tool calls to Jev, a paid classifier from [TypeSafe](https://typesafe.ai): a model that writes no text and answers fixed questions with probabilities. When Jev is confident, the plugin changes the model of the call, and for its own workers also the worker.

See [What leaves your machine](#what-leaves-your-machine) before you turn either one on.

## Why

Your Claude plan counts usage in two windows, periods that start again when they reset: a 5-hour window and a weekly window. Without routing, a subagent often runs on the same large model as the main session, even for a simple file search. That uses up both windows faster than needed. With routing on, the plugin picks Haiku for a search, Sonnet for most edits and reviews, and Opus for hard work. With Codex on, a hard implementation can go to Codex when its brief is self-contained: the brief holds everything that the task needs. So your ChatGPT plan takes part of the work.

The plugin calls no Claude or OpenAI API, so the work stays inside your plans. The one paid API is Jev, at about $0.00005 per call. Whether the routing saves money on your work is not proven yet; the [offline evaluation](EVALUATION.md) measures it.

## Requirements

- Claude Code with a Claude plan.
- Node.js 20 or newer. The plugin has no npm dependencies.
- For the routing: a TypeSafe API key for Jev.
- Optional: the Codex CLI with a ChatGPT login. Codex jobs need macOS or Linux. On Windows, the routing between Claude models works, and Codex stays off.

## Install

This repository is also a marketplace: a catalog of plugins that Claude Code can install from. Add it once, then install the plugin for one project:

```bash
claude plugin marketplace add robertanton81/claude-subagent-router
```

```bash
cd /path/to/your-project && claude plugin install subagent-router@claude-subagent-router --scope local
```

- `--scope local` turns the plugin on only in that project, in `.claude/settings.local.json`, which Git does not track. Leave it out to turn the plugin on in every project. The settings file is one file per user either way.
- If you already have a TypeSafe key, the command in [Turn on Jev](guide/setup.md#turn-on-jev) installs the plugin and stores the key in one step.
- `claude plugin marketplace update claude-subagent-router` fetches a new version.

## Setup

In a session, the skills `/subagent-router:configure` and `/subagent-router:setup` do this work. Each step below has full instructions in [Setup](guide/setup.md).

1. **Turn on Jev**, for the routing. Create a key at https://console.typesafe.ai/keys, store it in the plugin option (a setting that Claude Code keeps for the plugin), then turn Jev on with `/subagent-router:configure`. [Turn on Jev](guide/setup.md#turn-on-jev) has a command that keeps the key out of your shell history.
2. **Turn on Codex** (optional). Run `codex login` with your ChatGPT account, then turn Codex on with `/subagent-router:configure`.
3. **Add the status line log** (optional). The limit rules, which move work when Claude is near its limit, need your Claude usage numbers. Only your status line script receives them: it prints the line at the bottom of Claude Code. See [Add the status line log](guide/setup.md#add-the-status-line-log-optional).
4. **Check the setup** with `/subagent-router:setup`. The check never prints a secret.

## What leaves your machine

- **To TypeSafe, only while Jev is on:** the description and the whole brief of each routed subagent call, and the `Verification:` part of a finished worker's answer. Only when you turn on the finding triage, an experimental check of review findings, for a listed checkout: review findings with excerpts of the cited code.
- **To OpenAI, only while Codex is on:** the brief of each Codex implement task, custom review and consult, with your Claude instruction files, and anything that Codex reads while it works. Its sandbox, the limits that Codex puts on its own commands, restricts where Codex writes, not what it reads.
- **Nothing else.** The log, the Codex jobs and the settings stay in `~/.claude/orchestrator/`, readable only by your user.

The full list, with what is masked and how to send less, is in [What leaves your machine](guide/privacy.md).

## How it works

1. The main session hands work to subagents: the plugin's seven workers, or any other agent type.
2. The plugin's routing hook, a script that Claude Code runs at a fixed event, runs before each call of the `Agent` tool. While Jev is on, it sends the brief to Jev and gets answers to five questions about the task.
3. A table in code turns the answers into a route: a worker and a model for the plugin's workers, only a model for other agent types. When Jev is not confident, the call runs as the main session wrote it.
4. The hook writes every dispatch (one subagent call) to the log.

### The workers

| Worker | Runs on | Job |
| :-- | :-- | :-- |
| `subagent-router:searcher` | Haiku | Finds and explains code. Changes no files. |
| `subagent-router:complete-searcher` | Sonnet | Lists every match when the answer must be complete. Changes no files. |
| `subagent-router:implementer` | Sonnet | Writes and changes code inside a defined scope. |
| `subagent-router:debugger` | Opus | Finds the cause of a failure. |
| `subagent-router:reviewer` | Sonnet | Reviews changes. Changes no files. |
| `subagent-router:codex-implementer` | Codex CLI, started by a small Haiku agent | Implements a task on the ChatGPT plan. Needs a self-contained brief. |
| `subagent-router:codex-reviewer` | Codex CLI, started by a small Haiku agent | Reviews the uncommitted changes, a branch or a commit. |

Each worker sets its model and its effort (how much the model thinks before it answers) in its agent file; see [How the routing works](guide/routing.md).

## TypeSafe and Jev

TypeSafe is a third-party API. The plugin uses Jev because asking a Claude model would spend the plan that the plugin tries to save.

- A routed brief costs about $0.00005, or about $1 per 20,000 dispatches.
- While Jev is off, the hook sends nothing to TypeSafe and picks no model. The workers, the Codex workers while Codex is on, the writer lock (it stops two of the plugin's writers from changing one checkout at the same time) and the log still work.
- `/subagent-router:report` shows how many calls changed a route. When that share stays near zero, Jev costs money and saves nothing.

More in [TypeSafe and Jev](guide/jev.md).

## Use

After the setup, work as usual.

| Skill | What it does |
| :-- | :-- |
| `/subagent-router:report` | Shows what the routing did; see [The report and the log](guide/report-and-log.md). |
| `/subagent-router:review` | Reviews a change on three axes: rules, spec and bugs; see [The review skill](guide/review.md). |

A call was not rerouted? See [Why was a call not rerouted?](guide/report-and-log.md#why-was-a-call-not-rerouted).

## Configuration

All settings live in one optional file, `~/.claude/orchestrator/config.json`. Change it with `/subagent-router:configure`, with `node scripts/orch-config.mjs` from a clone, or by hand. Every key and its default are in [Configuration](guide/configuration.md).

## Known limits

- **Agents that the Workflow tool starts from a script are not routed,** and they take no writer lock.
- **The routing table and its gates, the confidence levels at which a rule acts, are first guesses.** Whether the routing saves money on real work is not established; see [EVALUATION.md](EVALUATION.md).
- **The writer lock has gaps.** It does not cover edits by the main session or calls to other agent types.
- **A Codex job can spend credits although `codexSpendCredits` is `false`,** when the saved plan numbers are old.

Every limit, with details, is in [Known limits](guide/known-limits.md).

## Documentation

[Setup](guide/setup.md) · [Configuration](guide/configuration.md) · [What leaves your machine](guide/privacy.md) · [How the routing works](guide/routing.md) · [When a plan is near its limit](guide/usage-limits.md) · [The writer lock](guide/writer-lock.md) · [Codex](guide/codex.md) · [TypeSafe and Jev](guide/jev.md) · [The report and the log](guide/report-and-log.md) · [The review skill](guide/review.md) · [Finding triage](guide/finding-triage.md) (experimental, off by default) · [Known limits](guide/known-limits.md) · [Offline evaluation](EVALUATION.md) · [Changelog](CHANGELOG.md) · [Security](SECURITY.md)

## Develop the plugin

Load a clone for one session with `claude --plugin-dir`, and run `npm test`, which needs no network and no key. See [Develop the plugin](guide/develop.md).
