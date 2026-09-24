import { REVIEWER_SET, WORKERS, WORKER_SET, WRITER_FAMILY } from "./config.mjs";

// The routing table. This file is the part to tune when the log shows wrong routes.
//
// Two functions read the same Jev answers:
//   decideRoute  for the plugin's own workers. It names a worker and a model.
//   decideModel  for every other agent type. It names only a model, because the
//                agent file of such an agent keeps its system prompt and its tools.
//
// Input:
//   answers  - the flat Jev answers from typesafe.mjs
//   context  - { claudeTight, lastWriterFamily, codexAvailable, codexTight, requestedAgent }
//              claudeTight comes from claudeState() in provider-state.mjs, which is
//              the one place that reads the limit numbers: at the gate, or on pace
//              to run out before the reset. A missing value means "unknown", and
//              unknown never counts as tight. requestedAgent is the agent type
//              that the orchestrator asked for.
//   config   - the gates from config.mjs
// Output of decideRoute:
//   { agent, model, reason }  when the table names a worker
//   { agent: null, reason }   when the orchestrator's choice should stand
// Output of decideModel:
//   { model, reason }         when the table names a model
//   { model: null, reason }   when the model of the call should stand

function to(agent, model, reason) {
  return { agent, model, reason };
}

function keep(reason) {
  return { agent: null, model: null, reason };
}

function atOrAbove(value, gate) {
  return typeof value === "number" && value >= gate;
}

// Jev's answer "this task changes files".
export function writesFiles(answers) {
  return typeof answers?.writesFiles === "number" && answers.writesFiles >= 0.5;
}

// Must this call wait while a Codex job changes files in its folder? The route
// hook asks this in enforce mode. The plugin's own writers and reviewers always
// wait. An agent type of another owner waits when Jev said that its task changes
// files. Without a Jev answer (`answers` is null, or holds only an error),
// nothing is known about the task, and the call does not wait: the hook fails
// open on every other unknown too.
export function writerLockApplies(finalAgent, answers) {
  if (WORKER_SET.has(finalAgent)) {
    return Boolean(WRITER_FAMILY[finalAgent] || REVIEWER_SET.has(finalAgent));
  }
  return writesFiles(answers);
}

// What both functions need to know about one dispatch.
function readFacts(answers, context, config) {
  // Confidence in the kind is not confidence in the difficulty. When Jev is not
  // sure how hard the task is, the table takes the normal route for the kind and
  // never moves the task to another provider or a bigger model because of it.
  const difficultyIsKnown = atOrAbove(answers.difficultyConfidence, config.difficultyGate);
  // The Score lands between levels, so round it. "Level 2 or more" means a score from 1.5.
  const level = difficultyIsKnown ? Math.round(answers.difficulty) : null;
  const claudeIsTight = context.claudeTight === true;
  const codexIsTight = context.codexTight === true;
  return {
    hard: level !== null && level >= 2,
    trivial: level !== null && level < 1,
    writes: writesFiles(answers),
    // This table sends no tasks to Codex while `codexAvailable` is false. It is false:
    //   - while Codex is off, which is the default
    //   - after a Codex job failed with a usage limit, until the pause ends
    //   - while the saved limit numbers show a used-up plan and `codexSpendCredits` is false
    codexCanDoIt: answers.selfContained >= config.selfContainedGate && context.codexAvailable !== false,
    // The limit rule moves work to the provider that still has room. When both are
    // tight, or both have room, every task takes its normal route.
    preferCodex: claudeIsTight && !codexIsTight,
    spareCodex: codexIsTight && !claudeIsTight,
    // The limit rule for Claude alone. While Claude usage is at the gate and Codex
    // cannot take work, no route goes above Sonnet.
    capAtSonnet: claudeIsTight && context.codexAvailable === false
  };
}

// Does the brief only have a right answer if it names every match? A missing
// answer (an older Jev, or a reply without the field) counts as "no", so the
// routing stays exactly as it was before the question existed.
function needsEveryMatch(answers, config) {
  return atOrAbove(answers.needsEveryMatch, config.completeGate);
}

// What the completeness rule would change, while it is only watching. The hook
// records this so the log can say how often the rule would fire, and on which
// briefs, before anyone lets it move a route. For the plugin's own searcher the
// rule would also change the worker; for other agent types only the model.
export function completenessShadow(answers, route, config) {
  if (config.completeRule !== "shadow" || route?.model !== "haiku" || answers.kind !== "search") {
    return null;
  }
  if (!needsEveryMatch(answers, config)) {
    return null;
  }
  return route.agent === WORKERS.searcher
    ? { agent: WORKERS.completeSearcher, model: "sonnet", reason: "needs_every_match" }
    : { model: "sonnet", reason: "needs_every_match" };
}

// The model for a task that runs on Claude, with the upper limit applied.
function claudeModel(model, reason, facts) {
  return facts.capAtSonnet && model === "opus" ? { model: "sonnet", reason: "claude_tight" } : { model, reason };
}

function toClaude(agent, model, reason, facts) {
  const picked = claudeModel(model, reason, facts);
  return to(agent, picked.model, picked.reason);
}

export function decideRoute(answers, context, config) {
  if (answers.kindConfidence < config.kindGate) {
    return keep("low_confidence");
  }
  const facts = readFacts(answers, context, config);
  const { hard, trivial, writes, codexCanDoIt, preferCodex, spareCodex } = facts;

  switch (answers.kind) {
    case "search":
      // A search that writes files means the two answers disagree.
      if (writes) {
        return keep("answers_disagree");
      }
      // The orchestrator asked for a complete listing. The small model is the
      // known way to lose an entry, so the table keeps that choice, rule or no rule.
      if (context.requestedAgent === WORKERS.completeSearcher) {
        return to(WORKERS.completeSearcher, "sonnet", "complete_requested");
      }
      if (needsEveryMatch(answers, config) && config.completeRule === "enforce") {
        return to(WORKERS.completeSearcher, "sonnet", "needs_every_match");
      }
      return to(WORKERS.searcher, "haiku", "search");

    case "mechanical_edit":
      if (!writes) {
        return keep("answers_disagree");
      }
      if (preferCodex && codexCanDoIt && !trivial) {
        return to(WORKERS.codexImplementer, "haiku", "limit_rule");
      }
      return to(WORKERS.implementer, trivial ? "haiku" : "sonnet", "mechanical_edit");

    case "implement":
      if (!writes) {
        return keep("answers_disagree");
      }
      if (codexCanDoIt && hard && !spareCodex) {
        return to(WORKERS.codexImplementer, "haiku", "hard_and_self_contained");
      }
      if (codexCanDoIt && preferCodex) {
        return to(WORKERS.codexImplementer, "haiku", "limit_rule");
      }
      if (hard && spareCodex) {
        return to(WORKERS.implementer, "opus", "codex_tight");
      }
      return hard ? toClaude(WORKERS.implementer, "opus", "hard_needs_context", facts) : to(WORKERS.implementer, "sonnet", "implement");

    case "debug":
      // The Codex implementer runs with a sandbox that can write. A diagnosis that
      // must change no files stays with the debugger, also when Claude is tight.
      if (preferCodex && codexCanDoIt && writes) {
        return to(WORKERS.codexImplementer, "haiku", "limit_rule");
      }
      return toClaude(WORKERS.debugger, "opus", "debug", facts);

    case "review":
      if (writes) {
        return keep("answers_disagree");
      }
      // The reviewer comes from the other model family than the author.
      // The orchestrator itself is Claude, so "no known author" counts as Claude.
      if (context.lastWriterFamily === "codex") {
        return to(WORKERS.reviewer, "sonnet", "cross_review");
      }
      if (!codexCanDoIt) {
        return to(WORKERS.reviewer, "sonnet", context.codexAvailable === false ? "codex_unavailable" : "review_needs_context");
      }
      return to(WORKERS.codexReviewer, "haiku", "cross_review");

    default:
      // "design", "other" and any option that a later Jev version may add.
      return keep(`kind_${answers.kind}`);
  }
}

// The model for an agent type that is not one of the plugin's workers. The rows
// match the Claude rows of decideRoute. There is no Codex row, because the hook
// never changes the agent type of such a call.
export function decideModel(answers, context, config) {
  const keepModel = (reason) => ({ model: null, reason });
  if (answers.kindConfidence < config.kindGate) {
    return keepModel("low_confidence");
  }
  const facts = readFacts(answers, context, config);
  const { hard, trivial, writes } = facts;

  switch (answers.kind) {
    case "search":
      if (writes) {
        return keepModel("answers_disagree");
      }
      if (needsEveryMatch(answers, config) && config.completeRule === "enforce") {
        return { model: "sonnet", reason: "needs_every_match" };
      }
      return { model: "haiku", reason: "search" };

    case "mechanical_edit":
      return writes ? { model: trivial ? "haiku" : "sonnet", reason: "mechanical_edit" } : keepModel("answers_disagree");

    case "implement":
      if (!writes) {
        return keepModel("answers_disagree");
      }
      return hard ? claudeModel("opus", "hard", facts) : { model: "sonnet", reason: "implement" };

    case "debug":
      return claudeModel("opus", "debug", facts);

    case "review":
      return writes ? keepModel("answers_disagree") : { model: "sonnet", reason: "review" };

    default:
      return keepModel(`kind_${answers.kind}`);
  }
}
