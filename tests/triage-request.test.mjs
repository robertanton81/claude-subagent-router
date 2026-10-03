import assert from "node:assert/strict";
import test from "node:test";

import { TRIAGE_OUTCOMES, buildTriageRequest, evalVersion } from "../scripts/lib/questions.mjs";
import { JevError, askTriage } from "../scripts/lib/typesafe.mjs";
import { startFakeJev } from "./helpers.mjs";

const config = { jevModel: "jev-1.13.0", jevUrl: "", jevTimeoutMs: 2000, reviewFormats: [] };
const finding = (index) => ({ index, text: `finding ${index}`, label: "P1", path: "src/a.mjs", start: 3, end: 4, excerpt: "3: a\n4: b" });

test("a request holds at most 12 findings and names the rest as skipped", () => {
  // Indexes differ from positions, as after earlier filtering: skipped must name the index.
  const { request, skipped } = buildTriageRequest(Array.from({ length: 14 }, (_, i) => finding(i * 2 + 1)), config);
  assert.equal(request.state.findings.length, 12);
  assert.deepEqual(skipped, [25, 27]);
  assert.equal(request.model, "jev-1.13.0");
  assert.deepEqual(Object.keys(request.questions), Array.from({ length: 12 }, (_, i) => `finding_${i}`));
});

test("each question is a Choice over the three outcomes about its own finding", () => {
  const { request } = buildTriageRequest([finding(0), finding(1)], config);
  for (const [n, id] of ["finding_0", "finding_1"].entries()) {
    const question = request.questions[id];
    assert.equal(question.type, "choice");
    assert.deepEqual(Object.keys(question.criteria), [...TRIAGE_OUTCOMES]);
    assert.match(question.instructions, new RegExp(`findings\\[${n}\\]`));
  }
  assert.deepEqual(request.state.findings[1], { text: "finding 1", label: "P1", path: "src/a.mjs", lines: "3-4", excerpt: "3: a\n4: b" });
});

test("the evaluation version changes with each part that decides a result, and only then", () => {
  const base = evalVersion(config);
  // The evidence rules are at version 3. The number is raised whenever those
  // rules change, so an evaluation never pools results made under different rules.
  assert.equal(base.evidence, "e4");
  assert.deepEqual(evalVersion({ ...config }), base);
  assert.notDeepEqual(evalVersion({ ...config, jevModel: "jev-1.14.0" }), base);
  const withFormats = evalVersion({ ...config, reviewFormats: [{ agentTypes: ["acme:review-bot"], labels: ["MUST-FIX"] }] });
  assert.notEqual(withFormats.parser, base.parser);
  assert.equal(withFormats.questions, base.questions);
});

test("askTriage maps each answer and marks a bad one as an error for that finding only", async (t) => {
  const fake = await startFakeJev({
    body: {
      model: "jev-1.13.0",
      answers: {
        finding_0: { type: "choice", choice: "contradicts", confidence: 0.9, probabilities: { contradicts: 0.9 } },
        finding_1: { type: "choice", choice: "maybe", confidence: 0.5 }
      },
      usage: { input_tokens: 900, output_tokens: 20 }
    }
  });
  t.after(fake.close);
  const { request } = buildTriageRequest([finding(0), finding(1)], config);
  const result = await askTriage(request, { ...config, jevUrl: fake.url }, "test-key-not-a-secret", 2000);
  assert.deepEqual(result.answers.finding_0, { choice: "contradicts", confidence: 0.9, probabilities: { contradicts: 0.9 } });
  assert.deepEqual(result.answers.finding_1, { error: "bad_answer" });
  assert.equal(result.model, "jev-1.13.0");
  assert.equal(fake.state.requests[0].body.questions.finding_1.type, "choice");
});

test("askTriage throws a timeout JevError when the answer is late", async (t) => {
  const fake = await startFakeJev({ body: { answers: {} }, delayMs: 500 });
  t.after(fake.close);
  const { request } = buildTriageRequest([finding(0)], config);
  await assert.rejects(askTriage(request, { ...config, jevUrl: fake.url }, "test-key-not-a-secret", 100), (error) => error instanceof JevError && error.code === "timeout");
});
