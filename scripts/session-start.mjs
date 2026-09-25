#!/usr/bin/env node
// SessionStart hook. Claude Code adds the plain text that this script prints to
// the context of the session. The text states facts. It gives no commands,
// because text that reads like a system command can be treated as an injection.

import fs from "node:fs";
import path from "node:path";

import { dataDir, loadConfig } from "./lib/config.mjs";
import { appendLog } from "./lib/log.mjs";
import { claudeCapNotice, claudeNotice, claudeState, codexNotice, codexState } from "./lib/provider-state.mjs";

// Nobody has set anything yet, so every setting is at its default and Codex is
// off. Saying so once, with the skill that changes it, is friendlier than
// leaving someone to find the settings file. It is a fact and not a command:
// the session decides whether to offer it.
function noSettingsFileYet() {
  try {
    return !fs.existsSync(path.join(dataDir(), "config.json"));
  } catch {
    // Reading the folder is not worth failing a session start over.
    return false;
  }
}

// The hook input names the session and the project. A `session` record in the
// log lets a report tell sessions and projects apart, also for a session that
// dispatches nothing. Input that is missing or broken writes no record and
// changes nothing else: the facts below do not depend on it.
function readHookInput() {
  try {
    const parsed = JSON.parse(fs.readFileSync(0, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function main() {
  const { config, warnings } = loadConfig();
  const codexOn = config.codexEnabled;

  const input = readHookInput();
  if (input) {
    appendLog({
      ts: new Date().toISOString(),
      event: "session",
      session_id: input.session_id ?? null,
      cwd: input.cwd ?? null,
      source: input.source ?? null,
      mode: config.mode,
      config: {
        kindGate: config.kindGate,
        difficultyGate: config.difficultyGate,
        selfContainedGate: config.selfContainedGate,
        limitGate: config.limitGate,
        pacing: config.pacing,
        paceAfter: config.paceAfter,
        jevEnabled: config.jevEnabled,
        codexEnabled: config.codexEnabled,
        codexSpendCredits: config.codexSpendCredits,
        routeOtherAgents: config.routeOtherAgents,
        keepModelAgents: config.keepModelAgents,
        jevModel: config.jevModel
      }
    });
  }

  const codexWorkers = codexOn
    ? [
        "- subagent-router:codex-implementer: runs the task in the Codex CLI on the ChatGPT plan. Codex starts with no context, so it needs a complete brief.",
        "- subagent-router:codex-reviewer: runs a Codex review of the uncommitted changes. A line `review-scope: base:<branch>`, `review-scope: commit:<hash>` or `review-scope: custom` in the brief picks another scope. When the hook moves a review from the Claude reviewer to Codex, the brief goes along as the review instructions (scope `custom`)."
      ]
    : ["- subagent-router:codex-implementer and subagent-router:codex-reviewer: off. Codex is opt-in, and `codexEnabled` is not true in the configuration. The hook moves a call to them to subagent-router:implementer or subagent-router:reviewer."];

  const reviewFact = codexOn
    ? "- After each logical piece of work, a reviewer from the other model family checks the change: Codex reviews changes from Claude workers, and the Claude reviewer reviews changes from Codex."
    : "- After each logical piece of work, subagent-router:reviewer checks the change. While Codex is off, no reviewer from another model family is available.";

  const jevOn = config.jevEnabled;
  const providerFact = !jevOn
    ? `- Routing is off, because \`jevEnabled\` is not true in the configuration: the hook changes no model, also when Claude usage is high, and each worker runs on the model of its agent file.${codexOn ? " While Codex has no capacity, a call to a Codex worker still runs on its Claude counterpart." : ""}`
    : codexOn
    ? "- When one subscription has no room left, work goes on with the other provider. The hook sends Codex tasks to Claude workers while Codex has no capacity, and it sends tasks with a complete brief to Codex while Claude usage is high. While Claude usage is high and Codex has no capacity, the hook picks no model above Sonnet. The main session tells the user in one sentence when a worker reports such a switch."
    : "- All delegated work runs on Claude workers. The hook sends no task to Codex, also when Claude usage is high. While Claude usage is high, the hook picks no model above Sonnet.";

  const keepLineFact =
    "- A line `orch-route: keep` in a brief makes the hook run that dispatch exactly as written. This fits a retry on a bigger model after a worker was blocked on a smaller one.";
  const otherAgentFacts = !jevOn
    ? ["- Dispatches to other agent types pass unchanged while routing is off."]
    : config.routeOtherAgents
    ? ["- For every other agent type, the hook can change only the model of a dispatch. The agent type stays, with its system prompt, its tools and its answer format.", keepLineFact]
    : ["- Dispatches to other agent types pass unchanged, because `routeOtherAgents` is false in the configuration.", keepLineFact];

  const lines = [
    `The subagent-router plugin is active in "${config.mode}" mode.`,
    "",
    "Workers for delegated work:",
    "- subagent-router:searcher (haiku): finds, reads and explains code. It changes no files.",
    "- subagent-router:complete-searcher (sonnet): lists every match when the answer is right only if the list is complete, such as every file that calls a function. It changes no files.",
    "- subagent-router:implementer (sonnet): writes and changes code inside a defined scope.",
    "- subagent-router:debugger (opus): finds the cause of a failure when the cause is not known.",
    "- subagent-router:reviewer (sonnet): reviews changes. It changes no files.",
    ...codexWorkers,
    "",
    "Facts about dispatches:",
    ...(jevOn ? ["- A routing hook can change the worker or the model of a dispatch to one of these workers. The tool result then says which worker ran."] : []),
    ...otherAgentFacts,
    "- Each dispatch costs tens of thousands of tokens before any work happens. Small tasks are cheaper when the main session does them.",
    "- Only one worker that changes files runs at a time, because all workers share one working tree. While a Codex job still changes files, the hook denies a new writer or reviewer and names the command to wait for the job or to cancel it.",
    "- A brief for a worker has five parts: Goal, Files, Constraints, Verify, Output.",
    "- A worker answers with three parts: Changed files, Verification, Open problems.",
    reviewFact,
    "- Review findings can be wrong. A finding is checked against the code before anyone acts on it.",
    providerFact,
    "",
    "The skill subagent-router:delegate has the full brief and result formats.",
    ...(noSettingsFileYet()
      ? [
          "",
          "No settings file exists for this plugin yet, so every setting is at its default, and routing (Jev) and Codex are off. The skill subagent-router:configure asks what the user wants and writes the file. Offer it once if the user has not asked for something else first."
        ]
      : []),
    ...(warnings.length > 0 ? ["", "Problems in the configuration of the subagent-router plugin (file ~/.claude/orchestrator/config.json):", ...warnings.map((warning) => `- ${warning}`)] : [])
  ];

  // A notice for the user needs the JSON form, because only `systemMessage` reaches
  // the user. Without a notice, plain text is enough.
  const notices = [];
  if (config.mode === "enforce") {
    const codex = codexState(config);
    // Off is the user's own choice, not a switch, so it gets no notice at each start.
    if (!codex.available && codex.reason !== "codex_disabled") {
      notices.push(codexNotice(codex));
    }
    const claude = claudeState(config);
    // The usage rules act through the routing table, which needs Jev. With Jev
    // off nothing moves, so a notice that says work now moves would be wrong.
    if (jevOn && claude.tight) {
      // The hook moves work to Codex only while Codex can take it. Otherwise it lowers the biggest model.
      notices.push(codex.available ? claudeNotice(claude) : claudeCapNotice(claude));
    }
  }
  if (notices.length === 0) {
    process.stdout.write(`${lines.join("\n")}\n`);
  } else {
    const context = [...lines, "", "State of the subscriptions right now:", ...notices.map((notice) => `- ${notice}`)].join("\n");
    process.stdout.write(
      JSON.stringify({
        systemMessage: `Subagent router: ${notices.join(" ")}`,
        hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context }
      })
    );
  }
}

try {
  main();
} catch (error) {
  // Fail open: a session must start without the facts rather than not at all.
  process.stderr.write(`subagent-router session start hook failed: ${error?.message ?? error}\n`);
  appendLog({ ts: new Date().toISOString(), event: "hook_error", hook: "session-start", error: String(error?.message ?? error) });
}
process.exitCode = 0;
