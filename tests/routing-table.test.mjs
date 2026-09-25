import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULTS, WORKERS } from "../scripts/lib/config.mjs";
import { completenessShadow, decideModel, decideRoute } from "../scripts/lib/routing-table.mjs";

const config = { ...DEFAULTS };
// The table reads one boolean for Claude. claudeState() decides it, and its
// tests are in log-and-config.test.mjs.
const noContext = { claudeTight: false, lastWriterFamily: null };
const tightContext = { claudeTight: true, lastWriterFamily: null };

function answers(overrides = {}) {
  return { kind: "implement", kindConfidence: 0.9, writesFiles: 0.95, selfContained: 0.9, difficulty: 1, difficultyConfidence: 0.8, ...overrides };
}

test("low confidence keeps the orchestrator's choice", () => {
  const route = decideRoute(answers({ kindConfidence: 0.59 }), noContext, config);
  assert.deepEqual(route, { agent: null, model: null, reason: "low_confidence" });
});

test("the gate value itself is confident enough", () => {
  assert.equal(decideRoute(answers({ kindConfidence: 0.6 }), noContext, config).agent, WORKERS.implementer);
});

test("search goes to the searcher on haiku", () => {
  const route = decideRoute(answers({ kind: "search", writesFiles: 0.05 }), noContext, config);
  assert.deepEqual(route, { agent: WORKERS.searcher, model: "haiku", reason: "search" });
});

// The completeness rule. It exists because a small model on a search brief was
// cheaper partly by listing nine of ten directories.
const searching = { kind: "search", writesFiles: 0.05 };

test("while the completeness rule only watches, it changes no route", () => {
  const exhaustive = answers({ ...searching, needsEveryMatch: 0.9 });
  const route = decideRoute(exhaustive, noContext, config);
  assert.deepEqual(route, { agent: WORKERS.searcher, model: "haiku", reason: "search" }, "the default config must route exactly as before the rule existed");
  assert.deepEqual(completenessShadow(exhaustive, route, config), { agent: WORKERS.completeSearcher, model: "sonnet", reason: "needs_every_match" }, "for the plugin's searcher the rule would change the worker too");
  assert.equal(decideModel(exhaustive, noContext, config).model, "haiku", "other agent types are unchanged too");
  // For another agent type the hook can change only the model, so that is all the record may claim.
  assert.deepEqual(completenessShadow(exhaustive, { agent: "Explore", model: "haiku", reason: "search" }, config), { model: "sonnet", reason: "needs_every_match" });
});

test("with the completeness rule in force, an exhaustive search moves to sonnet", () => {
  const on = { ...config, completeRule: "enforce" };
  const exhaustive = answers({ ...searching, needsEveryMatch: 0.9 });
  assert.deepEqual(decideRoute(exhaustive, noContext, on), { agent: WORKERS.completeSearcher, model: "sonnet", reason: "needs_every_match" });
  assert.deepEqual(decideModel(exhaustive, noContext, on), { model: "sonnet", reason: "needs_every_match" });
  assert.equal(completenessShadow(exhaustive, decideRoute(exhaustive, noContext, on), on), null, "a rule in force records no shadow");
  // A search that may leave items out is what the small model is for.
  const ordinary = answers({ ...searching, needsEveryMatch: 0.2 });
  assert.equal(decideRoute(ordinary, noContext, on).model, "haiku");
});

test("a search the orchestrator sent to the complete searcher stays there, whatever the rule says", () => {
  const asked = { ...noContext, requestedAgent: WORKERS.completeSearcher };
  const plain = answers({ ...searching, needsEveryMatch: 0.1 });
  const kept = { agent: WORKERS.completeSearcher, model: "sonnet", reason: "complete_requested" };
  // Jev does not think the list must be complete, and the rule only watches: the choice still stands.
  assert.deepEqual(decideRoute(plain, asked, config), kept);
  assert.deepEqual(decideRoute(plain, asked, { ...config, completeRule: "off" }), kept);
  // With the rule in force and Jev sure the list must be complete, the route is the same, and the log says
  // it was the orchestrator's choice: the rule never had to move the call.
  assert.deepEqual(decideRoute(answers({ ...searching, needsEveryMatch: 0.9 }), asked, { ...config, completeRule: "enforce" }), kept);
  assert.equal(completenessShadow(plain, decideRoute(plain, asked, config), config), null, "a kept route is not on haiku, so there is nothing to record");
  // The same brief to the plain searcher still goes to the small model.
  assert.deepEqual(decideRoute(plain, { ...noContext, requestedAgent: WORKERS.searcher }, config), { agent: WORKERS.searcher, model: "haiku", reason: "search" });
  // Only a search is kept. A brief that writes files, or that Jev reads as another kind, routes as before.
  assert.equal(decideRoute(answers({ kind: "search", writesFiles: 0.9 }), asked, config).reason, "answers_disagree");
  assert.equal(decideRoute(answers({ kind: "implement", writesFiles: 0.9 }), asked, config).agent, WORKERS.implementer);
  assert.equal(decideRoute(answers({ ...searching, kindConfidence: 0.1 }), asked, config).reason, "low_confidence");
  // Other agent types never get the worker: the hook can change only their model.
  assert.equal(decideModel(plain, asked, config).model, "haiku");
});

test("the completeness rule does nothing without an answer, below its gate, or when off", () => {
  const on = { ...config, completeRule: "enforce" };
  // An older Jev sends no such answer. The routing must stay as it was.
  assert.equal(decideRoute(answers({ ...searching, needsEveryMatch: null }), noContext, on).model, "haiku");
  assert.equal(decideRoute(answers({ ...searching }), noContext, on).model, "haiku", "no field at all is the same as no answer");
  assert.equal(decideRoute(answers({ ...searching, needsEveryMatch: 0.59 }), noContext, on).model, "haiku", "below the gate");
  assert.equal(decideRoute(answers({ ...searching, needsEveryMatch: 0.6 }), noContext, on).model, "sonnet", "the gate value itself counts");
  const off = { ...config, completeRule: "off" };
  const exhaustive = answers({ ...searching, needsEveryMatch: 0.9 });
  assert.equal(decideRoute(exhaustive, noContext, off).model, "haiku");
  assert.equal(completenessShadow(exhaustive, decideRoute(exhaustive, noContext, off), off), null, "off records nothing either");
  // The rule is about searches on the small model, nothing else.
  assert.equal(completenessShadow(answers({ kind: "implement", needsEveryMatch: 0.9 }), { model: "haiku" }, config), null);
  assert.equal(completenessShadow(exhaustive, { model: "sonnet" }, config), null);
});

test("a search that writes files means the answers disagree", () => {
  assert.equal(decideRoute(answers({ kind: "search", writesFiles: 0.8 }), noContext, config).reason, "answers_disagree");
});

test("an implement task that writes no files means the answers disagree", () => {
  assert.equal(decideRoute(answers({ writesFiles: 0.2 }), noContext, config).reason, "answers_disagree");
});

test("a trivial mechanical edit runs on haiku, a larger one on sonnet", () => {
  const trivial = decideRoute(answers({ kind: "mechanical_edit", difficulty: 0.3 }), noContext, config);
  const larger = decideRoute(answers({ kind: "mechanical_edit", difficulty: 0.6 }), noContext, config);
  assert.deepEqual([trivial.agent, trivial.model], [WORKERS.implementer, "haiku"]);
  assert.deepEqual([larger.agent, larger.model], [WORKERS.implementer, "sonnet"]);
});

test("a normal implement task runs on sonnet", () => {
  const route = decideRoute(answers({ difficulty: 1.2 }), noContext, config);
  assert.deepEqual([route.agent, route.model], [WORKERS.implementer, "sonnet"]);
});

test("a hard and self-contained implement task goes to Codex", () => {
  const route = decideRoute(answers({ difficulty: 2.1 }), noContext, config);
  assert.deepEqual([route.agent, route.reason], [WORKERS.codexImplementer, "hard_and_self_contained"]);
});

test("a hard task that needs outside context stays on Claude with opus", () => {
  const route = decideRoute(answers({ difficulty: 2.1, selfContained: 0.4 }), noContext, config);
  assert.deepEqual([route.agent, route.model, route.reason], [WORKERS.implementer, "opus", "hard_needs_context"]);
});

test("the limit rule moves self-contained work to Codex when Claude is tight", () => {
  assert.equal(decideRoute(answers({ difficulty: 1 }), tightContext, config).reason, "limit_rule");
  assert.equal(decideRoute(answers({ kind: "debug" }), tightContext, config).agent, WORKERS.codexImplementer);
  // Not self-contained: Codex cannot do it, so the rule does not apply.
  assert.equal(decideRoute(answers({ difficulty: 1, selfContained: 0.3 }), tightContext, config).agent, WORKERS.implementer);
});

test("the limit rule is off while Claude is not tight, and unknown never counts as tight", () => {
  assert.equal(decideRoute(answers(), noContext, config).agent, WORKERS.implementer);
  assert.equal(decideRoute(answers(), { lastWriterFamily: null }, config).agent, WORKERS.implementer);
  assert.equal(decideRoute(answers(), { claudeTight: null, lastWriterFamily: null }, config).agent, WORKERS.implementer);
  // Only the boolean true counts. A truthy value of another type is a programming error, not "tight".
  assert.equal(decideRoute(answers(), { claudeTight: "yes", lastWriterFamily: null }, config).agent, WORKERS.implementer);
});

test("debug goes to the debugger on opus", () => {
  const route = decideRoute(answers({ kind: "debug", writesFiles: 0.4 }), noContext, config);
  assert.deepEqual([route.agent, route.model], [WORKERS.debugger, "opus"]);
});

test("review goes to the other model family than the author", () => {
  const review = answers({ kind: "review", writesFiles: 0.02 });
  assert.equal(decideRoute(review, { ...noContext, lastWriterFamily: "claude" }, config).agent, WORKERS.codexReviewer);
  assert.equal(decideRoute(review, noContext, config).agent, WORKERS.codexReviewer);
  const afterCodex = decideRoute(review, { ...noContext, lastWriterFamily: "codex" }, config);
  assert.deepEqual([afterCodex.agent, afterCodex.model], [WORKERS.reviewer, "sonnet"]);
});

test("a review brief that is not self-contained stays with the Claude reviewer", () => {
  const route = decideRoute(answers({ kind: "review", writesFiles: 0.02, selfContained: 0.2 }), noContext, config);
  assert.deepEqual([route.agent, route.reason], [WORKERS.reviewer, "review_needs_context"]);
});

test("a task the orchestrator sent to a Codex worker stays on Codex while Codex can take it", () => {
  const toCodex = { ...noContext, codexAvailable: true, requestedAgent: WORKERS.codexImplementer };
  const kept = { agent: WORKERS.codexImplementer, model: "haiku", reason: "codex_requested" };
  // A medium task: without the request, the table sends it to the Claude implementer.
  assert.deepEqual(decideRoute(answers(), toCodex, config), kept);
  assert.deepEqual(decideRoute(answers({ kind: "mechanical_edit", difficulty: 0.2 }), toCodex, config), kept);
  assert.deepEqual(decideRoute(answers({ kind: "debug" }), toCodex, config), kept);
  // The orchestrator wrote the brief for Codex, so Jev's doubt about it does not undo the choice.
  assert.deepEqual(decideRoute(answers({ selfContained: 0.2 }), toCodex, config), kept);

  // Codex cannot take it: off, paused or used up.
  assert.equal(decideRoute(answers(), { ...toCodex, codexAvailable: false }, config).agent, WORKERS.implementer);
  // Codex is near its own limit and Claude is not: the table spares Codex, as for any task.
  assert.equal(decideRoute(answers(), { ...toCodex, codexTight: true }, config).agent, WORKERS.implementer);
  // A diagnosis that changes no files never gets the Codex sandbox that can write.
  assert.equal(decideRoute(answers({ kind: "debug", writesFiles: 0.1 }), toCodex, config).agent, WORKERS.debugger);
  // The answers disagree with the request: the table decides as before.
  assert.equal(decideRoute(answers({ kind: "search", writesFiles: 0.05 }), toCodex, config).agent, WORKERS.searcher);
});

test("a review the orchestrator sent to the Codex reviewer stays there, unless Codex wrote the change", () => {
  const toCodex = { ...noContext, codexAvailable: true, requestedAgent: WORKERS.codexReviewer };
  const review = answers({ kind: "review", writesFiles: 0.05, selfContained: 0.2 });
  // A scoped review needs no self-contained brief, so a low answer does not move it.
  assert.deepEqual(decideRoute(review, toCodex, config), { agent: WORKERS.codexReviewer, model: "haiku", reason: "codex_requested" });
  assert.deepEqual(decideRoute(review, { ...toCodex, lastWriterFamily: "codex" }, config), { agent: WORKERS.reviewer, model: "sonnet", reason: "cross_review" });
  assert.equal(decideRoute(review, { ...toCodex, codexAvailable: false }, config).agent, WORKERS.reviewer);
});

test("design, other and unknown kinds get no rewrite", () => {
  for (const kind of ["design", "other", "something_new"]) {
    const route = decideRoute(answers({ kind }), noContext, config);
    assert.deepEqual(route, { agent: null, model: null, reason: `kind_${kind}` });
  }
});

test("a diagnosis that changes no files never gets the Codex sandbox that can write", () => {
  const route = decideRoute(answers({ kind: "debug", writesFiles: 0.01 }), tightContext, config);
  assert.deepEqual([route.agent, route.model], [WORKERS.debugger, "opus"]);
});

test("an uncertain difficulty never moves a task to Codex or to a bigger model", () => {
  const unsure = answers({ difficulty: 2.6, difficultyConfidence: 0.05 });
  assert.deepEqual([decideRoute(unsure, noContext, config).agent, decideRoute(unsure, noContext, config).model], [WORKERS.implementer, "sonnet"]);
  const missing = answers({ difficulty: 2.6, difficultyConfidence: null });
  assert.equal(decideRoute(missing, noContext, config).model, "sonnet");
  // An uncertain "trivial" does not drop a mechanical edit to haiku either.
  assert.equal(decideRoute(answers({ kind: "mechanical_edit", difficulty: 0.1, difficultyConfidence: 0.1 }), noContext, config).model, "sonnet");
});

test("level 2 starts at a score of 1.5, because the score is rounded", () => {
  assert.equal(decideRoute(answers({ difficulty: 1.49 }), noContext, config).agent, WORKERS.implementer);
  assert.equal(decideRoute(answers({ difficulty: 1.5 }), noContext, config).agent, WORKERS.codexImplementer);
});

test("a tight Codex keeps hard tasks on Claude, and unavailable Codex gets nothing", () => {
  const hard = answers({ difficulty: 2.4 });
  const spare = decideRoute(hard, { ...noContext, codexTight: true }, config);
  assert.deepEqual([spare.agent, spare.model, spare.reason], [WORKERS.implementer, "opus", "codex_tight"]);
  // Both tight: no provider has room, so the normal route applies.
  assert.equal(decideRoute(hard, { ...tightContext, codexTight: true }, config).agent, WORKERS.codexImplementer);
  const gone = decideRoute(hard, { ...noContext, codexAvailable: false }, config);
  assert.deepEqual([gone.agent, gone.model], [WORKERS.implementer, "opus"]);
  assert.equal(decideRoute(answers({ kind: "review", writesFiles: 0.02 }), { ...noContext, codexAvailable: false }, config).reason, "codex_unavailable");
});

test("while Claude is tight and Codex cannot take work, no route goes above Sonnet", () => {
  const hard = answers({ difficulty: 2.4 });
  const debug = answers({ kind: "debug", writesFiles: 0.4 });
  const tightNoCodex = { ...tightContext, codexAvailable: false };

  assert.deepEqual(decideRoute(hard, tightNoCodex, config), { agent: WORKERS.implementer, model: "sonnet", reason: "claude_tight" });
  assert.deepEqual(decideRoute(debug, tightNoCodex, config), { agent: WORKERS.debugger, model: "sonnet", reason: "claude_tight" });

  // While Claude is not tight, or the value is unknown, the biggest model stays.
  assert.equal(decideRoute(hard, { ...tightNoCodex, claudeTight: false }, config).model, "opus");
  assert.equal(decideRoute(debug, { ...tightNoCodex, claudeTight: undefined }, config).model, "opus");
  // While Codex can take work, the older limit rule applies, and this one does not.
  const tightWithCodex = { ...tightContext, codexAvailable: true };
  assert.deepEqual([decideRoute(answers({ difficulty: 2.4, selfContained: 0.3 }), tightWithCodex, config).model, decideRoute(hard, tightWithCodex, config).agent], ["opus", WORKERS.codexImplementer]);

  // A route on Sonnet or Haiku keeps its model and its reason.
  assert.deepEqual(decideRoute(answers({ difficulty: 1 }), tightNoCodex, config), { agent: WORKERS.implementer, model: "sonnet", reason: "implement" });
  assert.deepEqual(decideRoute(answers({ kind: "search", writesFiles: 0.05 }), tightNoCodex, config), { agent: WORKERS.searcher, model: "haiku", reason: "search" });
});

test("decideModel names a model for each kind, and never a worker", () => {
  const cases = [
    [answers({ kind: "search", writesFiles: 0.05 }), { model: "haiku", reason: "search" }],
    [answers({ kind: "mechanical_edit", difficulty: 0.3 }), { model: "haiku", reason: "mechanical_edit" }],
    [answers({ kind: "mechanical_edit", difficulty: 0.6 }), { model: "sonnet", reason: "mechanical_edit" }],
    [answers({ difficulty: 1.2 }), { model: "sonnet", reason: "implement" }],
    // Hard and complete: one of our workers would go to Codex. Another agent type stays where it is.
    [answers({ difficulty: 2.4, selfContained: 0.95 }), { model: "opus", reason: "hard" }],
    [answers({ kind: "debug", writesFiles: 0.4 }), { model: "opus", reason: "debug" }],
    [answers({ kind: "review", writesFiles: 0.02 }), { model: "sonnet", reason: "review" }]
  ];
  for (const [input, expected] of cases) {
    assert.deepEqual(decideModel(input, noContext, config), expected);
  }
});

test("decideModel keeps the model of the call when Jev is unsure or the answers disagree", () => {
  const cases = [
    [answers({ kindConfidence: 0.59 }), "low_confidence"],
    [answers({ kind: "search", writesFiles: 0.8 }), "answers_disagree"],
    [answers({ kind: "mechanical_edit", writesFiles: 0.2 }), "answers_disagree"],
    [answers({ writesFiles: 0.2 }), "answers_disagree"],
    [answers({ kind: "review", writesFiles: 0.7 }), "answers_disagree"],
    [answers({ kind: "design" }), "kind_design"],
    [answers({ kind: "something_new" }), "kind_something_new"]
  ];
  for (const [input, reason] of cases) {
    assert.deepEqual(decideModel(input, noContext, config), { model: null, reason });
  }
});

test("decideModel reads the difficulty only when Jev is sure of it, and it ignores the limit rule for Codex", () => {
  assert.equal(decideModel(answers({ difficulty: 2.6, difficultyConfidence: 0.05 }), noContext, config).model, "sonnet");
  assert.equal(decideModel(answers({ kind: "mechanical_edit", difficulty: 0.1, difficultyConfidence: null }), noContext, config).model, "sonnet");
  // Claude is tight and Codex has room. One of our workers would move to Codex. Another agent type cannot move.
  const tightWithCodex = { ...tightContext, codexAvailable: true };
  assert.deepEqual(decideModel(answers({ difficulty: 1 }), tightWithCodex, config), { model: "sonnet", reason: "implement" });
  assert.deepEqual(decideModel(answers({ difficulty: 2.4 }), tightWithCodex, config), { model: "opus", reason: "hard" });
  // Codex cannot take work, so Sonnet is the upper limit.
  const tightNoCodex = { ...tightWithCodex, codexAvailable: false };
  assert.deepEqual(decideModel(answers({ difficulty: 2.4 }), tightNoCodex, config), { model: "sonnet", reason: "claude_tight" });
  assert.deepEqual(decideModel(answers({ kind: "debug" }), tightNoCodex, config), { model: "sonnet", reason: "claude_tight" });
});

test("on a Claude worker, both functions name the same model for the same answers", () => {
  // The two functions are written as two tables. This keeps them from drifting apart.
  // Codex is not available here, so decideRoute never leaves Claude.
  const contexts = [
    { ...noContext, codexAvailable: false },
    { ...tightContext, codexAvailable: false }
  ];
  let compared = 0;
  for (const context of contexts) {
    for (const kind of ["search", "mechanical_edit", "implement", "debug", "review", "design", "other"]) {
      for (const writesFiles of [0.05, 0.95]) {
        for (const difficulty of [0.2, 1, 1.49, 1.5, 2.8]) {
          for (const difficultyConfidence of [null, 0.2, 0.9]) {
            for (const kindConfidence of [0.3, 0.9]) {
              const input = answers({ kind, writesFiles, difficulty, difficultyConfidence, kindConfidence });
              assert.equal(decideModel(input, context, config).model, decideRoute(input, context, config).model, JSON.stringify({ context, input }));
              compared += 1;
            }
          }
        }
      }
    }
  }
  assert.equal(compared, 840);
});
