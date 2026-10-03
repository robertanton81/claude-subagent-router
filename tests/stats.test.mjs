import assert from "node:assert/strict";
import test from "node:test";

import { clopperPearsonLower, clopperPearsonUpper } from "../scripts/lib/stats.mjs";

test("the one-sided upper bound crosses 10 percent exactly where the bar says", () => {
  for (const [k, pass, fail] of [[0, 29, 28], [1, 46, 45], [2, 61, 60]]) {
    assert.ok(clopperPearsonUpper(k, pass) <= 0.1, `${k}/${pass} passes`);
    assert.ok(clopperPearsonUpper(k, fail) > 0.1, `${k}/${fail} fails`);
  }
  assert.equal(Number(clopperPearsonUpper(0, 52).toFixed(3)), 0.056);
});

test("the one-sided lower bound of 4 of 8 is about 0.19", () => {
  const lower = clopperPearsonLower(4, 8);
  assert.ok(lower > 0.19 && lower < 0.2, String(lower));
});

test("edge cases: no data gives the widest bounds", () => {
  assert.equal(clopperPearsonUpper(0, 0), 1);
  assert.equal(clopperPearsonUpper(5, 5), 1);
  assert.equal(clopperPearsonLower(0, 5), 0);
});
