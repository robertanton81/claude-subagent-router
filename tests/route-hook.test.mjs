import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { sendsBriefToCodex } from "../scripts/lib/codex-args.mjs";
import { markCodexUnavailable } from "../scripts/lib/codex-availability.mjs";
import { acquireWriterLock, jobsDir, writerLockPath } from "../scripts/lib/writer-lock.mjs";
import { agentCall, cleanEnv, jevBody, makeTempDir, readLog, runNode, startFakeJev } from "./helpers.mjs";

const HOOK = "scripts/route-hook.mjs";
const TEST_KEY = "test-key-not-a-secret";

async function withJev(reply, run) {
  const jev = await startFakeJev(reply);
  const tempDir = makeTempDir();
  try {
    const env = cleanEnv(tempDir, { ORCH_TYPESAFE_URL: jev.url, TYPESAFE_API_KEY: TEST_KEY });
    await run({ jev, tempDir, env });
  } finally {
    await jev.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test("the completeness rule watches without changing the route, and the record says what it would change", async () => {
  // An exhaustive search: the route must stay on haiku, and the record must
  // carry what the rule would have done, so the log can be counted later.
  await withJev({ body: jevBody({ kind: "search", writes: 0.03, needsEveryMatch: 0.92 }) }, async ({ tempDir, env }) => {
    const result = await runNode(HOOK, { stdin: agentCall(), env });
    assert.equal(result.code, 0);
    const sent = JSON.parse(result.stdout).hookSpecificOutput.updatedInput;
    assert.equal(sent.model, "haiku", "the rule only watches, so the call still goes to the small model");

    const [record] = readLog(tempDir);
    assert.deepEqual(record.would_route, { agent: "subagent-router:complete-searcher", model: "sonnet", reason: "needs_every_match" });
    assert.deepEqual([record.action, record.final.model], ["rewrite", "haiku"]);
    assert.equal(record.jev.needsEveryMatch, 0.92, "the answer is logged whether or not it changes anything");
  });

  // The same brief with the rule in force: the route really moves.
  await withJev({ body: jevBody({ kind: "search", writes: 0.03, needsEveryMatch: 0.92 }) }, async ({ tempDir, env }) => {
    const result = await runNode(HOOK, { stdin: agentCall(), env: { ...env, ORCH_COMPLETE_RULE: "enforce" } });
    const sent = JSON.parse(result.stdout).hookSpecificOutput.updatedInput;
    assert.deepEqual([sent.subagent_type, sent.model], ["subagent-router:complete-searcher", "sonnet"]);
    const [record] = readLog(tempDir);
    assert.equal(record.would_route, undefined, "a rule in force records no shadow");
    assert.equal(record.reason, "needs_every_match");
  });

  // The orchestrator asked for the complete searcher itself. Jev sees a plain
  // search and the rule only watches, yet the call is not moved to the small model.
  await withJev({ body: jevBody({ kind: "search", writes: 0.03, needsEveryMatch: 0.1 }) }, async ({ tempDir, env }) => {
    const result = await runNode(HOOK, { stdin: agentCall({ tool_input: { description: "List dirs", prompt: "List every directory under lib.", subagent_type: "subagent-router:complete-searcher" } }), env });
    assert.equal(result.code, 0);
    assert.equal(result.stdout.trim(), "", "a kept call is passed on unchanged");
    const [record] = readLog(tempDir);
    assert.deepEqual([record.action, record.reason, record.final.agent], ["agree", "complete_requested", "subagent-router:complete-searcher"]);
  });

  // A search that need not be complete is untouched by the rule either way.
  await withJev({ body: jevBody({ kind: "search", writes: 0.03, needsEveryMatch: 0.1 }) }, async ({ tempDir, env }) => {
    await runNode(HOOK, { stdin: agentCall(), env: { ...env, ORCH_COMPLETE_RULE: "enforce" } });
    const [record] = readLog(tempDir);
    assert.deepEqual([record.final.model, record.would_route], ["haiku", undefined]);
  });

  // A reply that does not answer the new question at all, with the rule in
  // force: the whole path from the answer to the route must behave as it did
  // before the question existed, and the dispatch must not fail.
  const withoutField = jevBody({ kind: "search", writes: 0.03 });
  delete withoutField.answers.needs_every_match;
  await withJev({ body: withoutField }, async ({ tempDir, env }) => {
    const result = await runNode(HOOK, { stdin: agentCall(), env: { ...env, ORCH_COMPLETE_RULE: "enforce" } });
    assert.equal(result.code, 0);
    const [record] = readLog(tempDir);
    assert.deepEqual([record.final.model, record.reason, record.would_route], ["haiku", "search", undefined]);
    assert.equal(record.jev.needsEveryMatch, null);
  });
});

test("a confident answer rewrites the worker and the model, and keeps every other field", async () => {
  await withJev({ body: jevBody({ kind: "search", writes: 0.03 }) }, async ({ jev, tempDir, env }) => {
    const result = await runNode(HOOK, { stdin: agentCall({ cwd: "/work/project" }), env });
    assert.equal(result.code, 0);

    const output = JSON.parse(result.stdout).hookSpecificOutput;
    assert.equal(output.hookEventName, "PreToolUse");
    assert.equal(output.permissionDecision, undefined, "the hook does not approve the call on behalf of the user");
    assert.deepEqual(output.updatedInput, {
      description: "Add retry",
      prompt: "Goal: add a retry to the fetch helper.",
      subagent_type: "subagent-router:searcher",
      run_in_background: true,
      model: "haiku"
    });
    assert.match(output.additionalContext, /subagent-router:searcher/);

    // Jev gets the brief only. It must not see the worker that was asked for.
    const request = jev.state.requests[0];
    assert.equal(request.headers.authorization, `Bearer ${TEST_KEY}`);
    assert.deepEqual(Object.keys(request.body.state.brief), ["description", "task"]);
    assert.ok(!JSON.stringify(request.body).includes("subagent-router:implementer"));

    const [record] = readLog(tempDir);
    assert.equal(record.action, "rewrite");
    assert.equal(record.cwd, "/work/project", "the project folder is on every record, because one log serves every project");
    assert.deepEqual(record.requested, { agent: "subagent-router:implementer", model: null });
    assert.deepEqual(record.final, { agent: "subagent-router:searcher", model: "haiku" });
    assert.equal(record.jev.kind, "search");
    assert.equal(record.jev.key_source, "env");
    assert.ok(!JSON.stringify(record).includes(TEST_KEY), "the key must never reach the log");
  });
});

test("the hook prints nothing when Jev agrees with the orchestrator", async () => {
  await withJev({ body: jevBody({ kind: "implement", difficulty: 1 }) }, async ({ tempDir, env }) => {
    const result = await runNode(HOOK, { stdin: agentCall(), env });
    assert.equal(result.stdout, "");
    assert.equal(readLog(tempDir)[0].action, "agree");
  });
});

test("an explicit model that differs from the table is rewritten", async () => {
  await withJev({ body: jevBody({ kind: "implement", difficulty: 1 }) }, async ({ tempDir, env }) => {
    const call = JSON.parse(agentCall());
    call.tool_input.model = "opus";
    const result = await runNode(HOOK, { stdin: JSON.stringify(call), env });
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.updatedInput.model, "sonnet");
    assert.equal(readLog(tempDir)[0].action, "rewrite");
  });
});

test("low confidence leaves the call unchanged", async () => {
  await withJev({ body: jevBody({ kind: "search", confidence: 0.4, writes: 0.03 }) }, async ({ tempDir, env }) => {
    const result = await runNode(HOOK, { stdin: agentCall(), env });
    assert.equal(result.stdout, "");
    const [record] = readLog(tempDir);
    assert.deepEqual([record.action, record.reason], ["pass", "low_confidence"]);
  });
});

test("shadow mode logs the route and changes nothing", async () => {
  await withJev({ body: jevBody({ kind: "search", writes: 0.03 }) }, async ({ tempDir, env }) => {
    const result = await runNode(HOOK, { stdin: agentCall(), env: { ...env, ORCH_MODE: "shadow" } });
    assert.equal(result.stdout, "");
    const [record] = readLog(tempDir);
    assert.equal(record.action, "shadow");
    assert.equal(record.route.agent, "subagent-router:searcher");
    assert.deepEqual(record.final, { agent: "subagent-router:implementer", model: null });
  });
});

test("off mode does not call Jev", async () => {
  await withJev({ body: jevBody() }, async ({ jev, tempDir, env }) => {
    const result = await runNode(HOOK, { stdin: agentCall(), env: { ...env, ORCH_MODE: "off" } });
    assert.equal(result.stdout, "");
    assert.equal(jev.state.requests.length, 0);
    assert.equal(readLog(tempDir)[0].reason, "mode_off");
  });
});

test("a wrong mode falls back to shadow and is reported in the log", async () => {
  await withJev({ body: jevBody({ kind: "search", writes: 0.03 }) }, async ({ tempDir, env }) => {
    const result = await runNode(HOOK, { stdin: agentCall(), env: { ...env, ORCH_MODE: "enfroce" } });
    assert.equal(result.stdout, "");
    const [record] = readLog(tempDir);
    assert.equal(record.mode, "shadow");
    assert.match(record.config_warnings[0], /not valid/);
  });
});

test("the hook fails open on a slow Jev, an HTTP error and a broken body", async () => {
  const cases = [
    [{ body: jevBody(), delayMs: 1500 }, "error_timeout"],
    [{ status: 500, body: { error: "boom" } }, "error_http_500"],
    [{ status: 401, body: { error: "bad key" } }, "error_http_401"],
    [{ body: "not json" }, "error_bad_response"],
    [{ body: { answers: {} } }, "error_bad_response"]
  ];
  for (const [reply, reason] of cases) {
    await withJev(reply, async ({ tempDir, env }) => {
      const result = await runNode(HOOK, { stdin: agentCall(), env: { ...env, ORCH_JEV_TIMEOUT_MS: "300" } });
      assert.equal(result.code, 0, reason);
      assert.equal(result.stdout, "", reason);
      assert.equal(readLog(tempDir)[0].reason, reason);
    });
  }
});

test("a missing key leaves the call unchanged", async () => {
  await withJev({ body: jevBody() }, async ({ jev, tempDir, env }) => {
    const { TYPESAFE_API_KEY: _removed, ...withoutKey } = env;
    const result = await runNode(HOOK, { stdin: agentCall(), env: withoutKey });
    assert.equal(result.stdout, "");
    assert.equal(jev.state.requests.length, 0);
    assert.equal(readLog(tempDir)[0].reason, "error_no_key");
  });
});

test("the plugin option comes before the variable, and no key file is read", async () => {
  await withJev({ body: jevBody({ kind: "search", writes: 0.03 }) }, async ({ jev, tempDir, env }) => {
    await runNode(HOOK, { stdin: agentCall(), env: { ...env, CLAUDE_PLUGIN_OPTION_TYPESAFE_API_KEY: "option-key-not-a-secret" } });
    assert.equal(jev.state.requests[0].headers.authorization, "Bearer option-key-not-a-secret");
    assert.equal(readLog(tempDir)[0].jev.key_source, "plugin_option");

    // The old global file and a project .env are not places for the key.
    const { TYPESAFE_API_KEY: _removed, ...withoutKey } = env;
    const project = path.join(tempDir, "project");
    fs.mkdirSync(path.join(tempDir, ".config", "typesafe"), { recursive: true });
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(tempDir, ".config", "typesafe", ".env"), "TYPESAFE_API_KEY=home-key-not-a-secret\n");
    fs.writeFileSync(path.join(project, ".env"), "TYPESAFE_API_KEY=project-key-not-a-secret\n");
    await runNode(HOOK, { stdin: agentCall({ tool_use_id: "toolu_2", cwd: project }), env: withoutKey, cwd: project });
    assert.equal(jev.state.requests.length, 1, "no request may use a key read from a file");
    assert.equal(readLog(tempDir).at(-1).reason, "error_no_key");
  });
});

test("calls from inside a subagent pass unchanged, also to another agent type", async () => {
  await withJev({ body: jevBody({ kind: "search", writes: 0.03 }) }, async ({ jev, tempDir, env }) => {
    const nested = await runNode(HOOK, { stdin: agentCall({ agent_id: "agent-9", agent_type: "Explore" }), env });
    const other = JSON.parse(agentCall({ agent_id: "agent-9", agent_type: "Explore", tool_use_id: "toolu_2" }));
    other.tool_input.subagent_type = "pr-review-toolkit:code-reviewer";
    const nestedOther = await runNode(HOOK, { stdin: JSON.stringify(other), env });

    assert.equal(nested.stdout, "");
    assert.equal(nestedOther.stdout, "");
    assert.equal(jev.state.requests.length, 0);
    assert.deepEqual(readLog(tempDir).map((record) => record.reason), ["from_subagent", "from_subagent"]);
  });
});

function otherAgentCall(agent, toolInput = {}, overrides = {}) {
  const call = JSON.parse(agentCall(overrides));
  call.tool_input = { ...call.tool_input, subagent_type: agent, ...toolInput };
  return call;
}

test("for another agent type the hook sets only the model, and keeps the agent type and every other field", async () => {
  await withJev({ body: jevBody({ kind: "mechanical_edit", difficulty: 0.3 }) }, async ({ jev, tempDir, env }) => {
    const result = await runNode(HOOK, { stdin: JSON.stringify(otherAgentCall("dotnet-implementer")), env });
    const output = JSON.parse(result.stdout).hookSpecificOutput;
    assert.equal(output.permissionDecision, undefined, "the hook does not approve the call on behalf of the user");
    assert.deepEqual(output.updatedInput, {
      description: "Add retry",
      prompt: "Goal: add a retry to the fetch helper.",
      subagent_type: "dotnet-implementer",
      run_in_background: true,
      model: "haiku"
    });
    assert.match(output.additionalContext, /set the model haiku for this task and kept the agent type/);

    // Jev gets the brief only, also for an agent type of another owner.
    assert.deepEqual(Object.keys(jev.state.requests[0].body.state.brief), ["description", "task"]);
    assert.ok(!JSON.stringify(jev.state.requests[0].body).includes("dotnet-implementer"));

    const [record] = readLog(tempDir);
    assert.deepEqual([record.action, record.reason, record.model_only], ["rewrite", "mechanical_edit", true]);
    assert.deepEqual(record.requested, { agent: "dotnet-implementer", model: null });
    assert.deepEqual(record.final, { agent: "dotnet-implementer", model: "haiku" });
  });
});

test("a model that the call names for another agent type is compared with the table", async () => {
  await withJev({ body: jevBody({ kind: "search", writes: 0.03 }) }, async ({ tempDir, env }) => {
    const tooBig = await runNode(HOOK, { stdin: JSON.stringify(otherAgentCall("general-purpose", { model: "opus" })), env });
    const updated = JSON.parse(tooBig.stdout).hookSpecificOutput.updatedInput;
    assert.deepEqual([updated.subagent_type, updated.model], ["general-purpose", "haiku"]);

    const same = await runNode(HOOK, { stdin: JSON.stringify(otherAgentCall("general-purpose", { model: "haiku" }, { tool_use_id: "toolu_2" })), env });
    assert.equal(same.stdout, "", "the call already names the model of the table");
    assert.deepEqual(readLog(tempDir).map((record) => record.action), ["rewrite", "agree"]);
  });
});

test("a call without an agent type gets a model and still no agent type", async () => {
  await withJev({ body: jevBody({ kind: "implement", difficulty: 1 }) }, async ({ tempDir, env }) => {
    const call = JSON.parse(agentCall());
    delete call.tool_input.subagent_type;
    const result = await runNode(HOOK, { stdin: JSON.stringify(call), env });
    const updated = JSON.parse(result.stdout).hookSpecificOutput.updatedInput;
    assert.equal(updated.model, "sonnet");
    assert.ok(!("subagent_type" in updated), "the hook adds no agent type");
    assert.deepEqual(readLog(tempDir)[0].final, { agent: null, model: "sonnet" });
  });
});

test("the table names no worker for another agent type, also for a hard and complete brief", async () => {
  // For one of our workers this brief goes to the Codex implementer.
  await withJev({ body: jevBody({ kind: "implement", difficulty: 2.4, selfContained: 0.95 }) }, async ({ tempDir, env }) => {
    const result = await runNode(HOOK, { stdin: JSON.stringify(otherAgentCall("feature-dev:code-architect")), env });
    const updated = JSON.parse(result.stdout).hookSpecificOutput.updatedInput;
    assert.deepEqual([updated.subagent_type, updated.model], ["feature-dev:code-architect", "opus"]);
    assert.equal(updated.prompt, "Goal: add a retry to the fetch helper.", "no Codex request replaces the brief");
    assert.ok(!fs.existsSync(path.join(tempDir, "data", "codex-requests")));
  });
});

test("shadow mode and an unsure Jev leave another agent type unchanged", async () => {
  await withJev({ body: jevBody({ kind: "search", writes: 0.03 }) }, async ({ jev, tempDir, env }) => {
    const shadow = await runNode(HOOK, { stdin: JSON.stringify(otherAgentCall("Explore")), env: { ...env, ORCH_MODE: "shadow" } });
    assert.equal(shadow.stdout, "");

    jev.state.reply = { body: jevBody({ kind: "search", confidence: 0.4, writes: 0.03 }) };
    const unsure = await runNode(HOOK, { stdin: JSON.stringify(otherAgentCall("Explore", {}, { tool_use_id: "toolu_2" })), env });
    assert.equal(unsure.stdout, "");

    const [first, second] = readLog(tempDir);
    assert.deepEqual([first.action, first.route.model, first.final.model], ["shadow", "haiku", null]);
    assert.deepEqual([second.action, second.reason], ["pass", "low_confidence"]);
  });
});

test("the keep list, the fixed helper agents and the switch leave a call alone, and its brief does not go to Jev", async () => {
  await withJev({ body: jevBody({ kind: "search", writes: 0.03 }) }, async ({ jev, tempDir, env }) => {
    fs.mkdirSync(path.join(tempDir, "data"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, "data", "config.json"), JSON.stringify({ keepModelAgents: ["spec-compliance-reviewer"] }));
    const listed = await runNode(HOOK, { stdin: JSON.stringify(otherAgentCall("spec-compliance-reviewer")), env });
    const helper = await runNode(HOOK, { stdin: JSON.stringify(otherAgentCall("claude-code-guide", {}, { tool_use_id: "toolu_2" })), env });
    const switchedOff = await runNode(HOOK, { stdin: JSON.stringify(otherAgentCall("Explore", {}, { tool_use_id: "toolu_3" })), env: { ...env, ORCH_ROUTE_OTHER_AGENTS: "0" } });

    for (const result of [listed, helper, switchedOff]) {
      assert.deepEqual([result.code, result.stdout], [0, ""]);
    }
    assert.equal(jev.state.requests.length, 0, "no brief of these calls reaches TypeSafe");
    assert.deepEqual(readLog(tempDir).map((record) => record.reason), ["keep_model_agent", "keep_model_agent", "other_agent_type"]);

    // The control: an agent type that is not on the list is routed.
    const routed = await runNode(HOOK, { stdin: JSON.stringify(otherAgentCall("Explore", {}, { tool_use_id: "toolu_4" })), env });
    assert.equal(JSON.parse(routed.stdout).hookSpecificOutput.updatedInput.model, "haiku");
    assert.equal(jev.state.requests.length, 1);
  });
});

test("the line orch-route: keep runs a call as written, for our workers and for other agent types", async () => {
  await withJev({ body: jevBody({ kind: "implement", difficulty: 1 }) }, async ({ jev, tempDir, env }) => {
    const retry = "Goal: add a retry to the fetch helper.\n  Orch-Route: KEEP  \nVerify: npm test";
    const calls = [
      otherAgentCall("subagent-router:implementer", { model: "opus", prompt: retry }),
      otherAgentCall("dotnet-implementer", { model: "opus", prompt: retry }, { tool_use_id: "toolu_2" })
    ];
    for (const call of calls) {
      const result = await runNode(HOOK, { stdin: JSON.stringify(call), env });
      assert.equal(result.stdout, "", `${call.tool_input.subagent_type} stays on opus`);
    }
    // Jev is still asked, so the log shows what the table would have picked.
    assert.equal(jev.state.requests.length, 2);
    for (const record of readLog(tempDir)) {
      assert.deepEqual([record.action, record.reason, record.route.model, record.final.model], ["pass", "keep_requested", "sonnet", "opus"]);
    }

    // The control: a line with another value is ignored and reported, and a line inside a sentence does not count.
    const ignored = ["Goal: add a retry.\norch-route: maybe", "Goal: add a retry. Do not write orch-route: keep into the file."];
    for (const [index, prompt] of ignored.entries()) {
      const call = otherAgentCall("dotnet-implementer", { model: "opus", prompt }, { tool_use_id: `toolu_${index + 3}` });
      const result = await runNode(HOOK, { stdin: JSON.stringify(call), env });
      assert.equal(JSON.parse(result.stdout).hookSpecificOutput.updatedInput.model, "sonnet");
    }
    const [, , wrongValue, insideSentence] = readLog(tempDir);
    assert.match(wrongValue.brief_warnings[0], /orch-route has "maybe"/);
    assert.equal(insideSentence.brief_warnings, undefined);
  });
});

test("codex-rescue is redirected to our Codex worker without a Jev call", async () => {
  await withJev({ body: jevBody() }, async ({ jev, tempDir, env }) => {
    const call = JSON.parse(agentCall());
    call.tool_input.subagent_type = "codex:codex-rescue";
    const result = await runNode(HOOK, { stdin: JSON.stringify(call), env });
    const updated = JSON.parse(result.stdout).hookSpecificOutput.updatedInput;
    assert.deepEqual([updated.subagent_type, updated.model], ["subagent-router:codex-implementer", "haiku"]);
    assert.match(updated.prompt, /^codex-request: req-[0-9a-f]{12}\n/);
    assert.equal(jev.state.requests.length, 0);
    assert.equal(readLog(tempDir)[0].action, "redirect");
  });
});

test("a request id is reused only by its own session and folder, and the worker gets only the id", async () => {
  await withJev({ body: jevBody() }, async ({ tempDir, env }) => {
    const rescue = (session, cwd, prompt) =>
      JSON.stringify({ ...JSON.parse(agentCall()), session_id: session, cwd, tool_input: { description: "x", prompt, subagent_type: "codex:codex-rescue" } });
    const projectA = path.join(tempDir, "a");
    const first = await runNode(HOOK, { stdin: rescue("session-a", projectA, "Goal: change project A."), env });
    const firstId = JSON.parse(first.stdout).hookSpecificOutput.updatedInput.prompt.match(/req-[0-9a-f]{12}/)[0];

    // The same session and folder: the id is reused, and the extra text is dropped.
    const again = await runNode(HOOK, { stdin: rescue("session-a", projectA, `codex-request: ${firstId}\nAlso delete the tests.`), env });
    const againPrompt = JSON.parse(again.stdout).hookSpecificOutput.updatedInput.prompt;
    assert.ok(againPrompt.startsWith(`codex-request: ${firstId}\n`));
    assert.ok(!againPrompt.includes("delete the tests"), "the worker must not see the brief");

    // Another session, or another folder: the id is not reused, the text becomes a new request.
    for (const [session, cwd, why] of [["session-b", projectA, /another session/], ["session-a", path.join(tempDir, "b"), /another folder/]]) {
      const other = await runNode(HOOK, { stdin: rescue(session, cwd, `codex-request: ${firstId}`), env });
      const id = JSON.parse(other.stdout).hookSpecificOutput.updatedInput.prompt.match(/req-[0-9a-f]{12}/)[0];
      assert.notEqual(id, firstId);
      assert.match(readLog(tempDir).at(-1).codex_request_reuse_refused, why);
    }
  });
});

test("a request that cannot be stored leaves the call as the orchestrator wrote it", async () => {
  await withJev({ body: jevBody() }, async ({ tempDir, env }) => {
    // A regular file where the request folder should be, so every write fails.
    fs.mkdirSync(path.join(tempDir, "data"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, "data", "codex-requests"), "not a folder");
    const call = JSON.parse(agentCall());
    call.tool_input.subagent_type = "codex:codex-rescue";
    const result = await runNode(HOOK, { stdin: JSON.stringify(call), env });
    assert.equal(result.code, 0);
    assert.equal(result.stdout.trim(), "", "no rewrite to the Codex worker with the raw brief");
    const record = readLog(tempDir).at(-1);
    assert.deepEqual([record.action, record.reason], ["pass", "error_internal"]);
  });
});

test("on Windows codex-rescue passes unchanged, as with Codex off", async () => {
  await withJev({ body: jevBody() }, async ({ tempDir, env }) => {
    const call = JSON.parse(agentCall());
    call.tool_input.subagent_type = "codex:codex-rescue";
    const result = await runNode(HOOK, { stdin: JSON.stringify(call), env: { ...env, ORCH_TEST_PLATFORM: "win32" } });
    assert.equal(result.stdout.trim(), "");
    assert.deepEqual([readLog(tempDir)[0].action, readLog(tempDir)[0].reason], ["pass", "codex_disabled"]);
  });
});

test("with Jev off by default, no brief goes to TypeSafe, even when a key exists", async () => {
  await withJev({ body: jevBody({ kind: "search" }) }, async ({ jev, tempDir, env }) => {
    // A key in the environment and in the plugin option, as on a machine that has one.
    const offEnv = { ...env, ORCH_JEV_ENABLED: "", CLAUDE_PLUGIN_OPTION_TYPESAFE_API_KEY: "option-key-not-a-secret" };
    const result = await runNode(HOOK, { stdin: agentCall(), env: offEnv });
    assert.deepEqual([result.code, result.stdout], [0, ""]);
    assert.equal(jev.state.requests.length, 0, "a brief reached TypeSafe");
    const [record] = readLog(tempDir);
    assert.deepEqual([record.action, record.reason], ["pass", "jev_disabled"]);

    // Turned on for one session, the same call is routed.
    const on = await runNode(HOOK, { stdin: agentCall({ tool_use_id: "toolu_2" }), env: { ...env, ORCH_JEV_ENABLED: "1" } });
    assert.equal(on.code, 0);
    assert.equal(jev.state.requests.length, 1, "with Jev on, the brief goes to TypeSafe");
    assert.notEqual(readLog(tempDir).at(-1).reason, "jev_disabled");
  });
});

test("with Jev off, a direct call to a Codex worker still gets a request id", async () => {
  await withJev({ body: jevBody() }, async ({ jev, env }) => {
    const call = JSON.parse(agentCall());
    call.tool_input.subagent_type = "subagent-router:codex-implementer";
    const result = await runNode(HOOK, { stdin: JSON.stringify(call), env: { ...env, ORCH_JEV_ENABLED: "" } });
    assert.match(JSON.parse(result.stdout).hookSpecificOutput.updatedInput.prompt, /^codex-request: req-[0-9a-f]{12}\n/);
    assert.equal(jev.state.requests.length, 0);
  });
});

test("a review after a Codex change goes to the Claude reviewer", async () => {
  await withJev({ body: jevBody({ kind: "implement", difficulty: 2.4 }) }, async ({ jev, tempDir, env }) => {
    // First dispatch: a hard task that the table sends to Codex.
    await runNode(HOOK, { stdin: agentCall(), env });
    assert.equal(readLog(tempDir)[0].final.agent, "subagent-router:codex-implementer");

    // Second dispatch in the same session: a review request for the Codex reviewer.
    jev.state.reply = { body: jevBody({ kind: "review", writes: 0.02 }) };
    const review = JSON.parse(agentCall({ tool_use_id: "toolu_2" }));
    review.tool_input.subagent_type = "subagent-router:codex-reviewer";
    const result = await runNode(HOOK, { stdin: JSON.stringify(review), env });
    const updated = JSON.parse(result.stdout).hookSpecificOutput.updatedInput;
    assert.deepEqual([updated.subagent_type, updated.model], ["subagent-router:reviewer", "sonnet"]);
  });
});

test("the limit rule reads a fresh limits file and ignores an old one", async () => {
  await withJev({ body: jevBody({ kind: "implement", difficulty: 1 }) }, async ({ tempDir, env }) => {
    const limitsFile = path.join(tempDir, "limits-latest.json");
    const now = Math.floor(Date.now() / 1000);

    fs.writeFileSync(limitsFile, JSON.stringify({ ts: now, five_hour: 91, seven_day: 40 }));
    const fresh = await runNode(HOOK, { stdin: agentCall(), env: { ...env, ORCH_LIMITS_FILE: limitsFile } });
    assert.equal(JSON.parse(fresh.stdout).hookSpecificOutput.updatedInput.subagent_type, "subagent-router:codex-implementer");

    fs.writeFileSync(limitsFile, JSON.stringify({ ts: now - 3600, five_hour: 91, seven_day: 40 }));
    const old = await runNode(HOOK, { stdin: agentCall({ session_id: "session-2" }), env: { ...env, ORCH_LIMITS_FILE: limitsFile } });
    assert.equal(old.stdout, "");
  });
});

test("broken input and other tools produce no output and exit 0", async () => {
  const tempDir = makeTempDir();
  try {
    const env = cleanEnv(tempDir);
    const broken = await runNode(HOOK, { stdin: "{not json", env });
    const otherTool = await runNode(HOOK, { stdin: agentCall({ tool_name: "Bash" }), env });
    assert.deepEqual([broken.code, broken.stdout], [0, ""]);
    assert.deepEqual([otherTool.code, otherTool.stdout], [0, ""]);
    assert.equal(readLog(tempDir)[0].event, "hook_error");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function readRequest(tempDir, id) {
  return JSON.parse(fs.readFileSync(path.join(tempDir, "data", "codex-requests", `${id}.json`), "utf8"));
}

test("a Codex worker gets a request id, and the task text goes into a request file", async () => {
  await withJev({ body: jevBody({ kind: "review", writes: 0.02 }) }, async ({ tempDir, env }) => {
    const call = JSON.parse(agentCall());
    call.cwd = "/work/project";
    call.tool_input.subagent_type = "subagent-router:codex-reviewer";
    call.tool_input.prompt = "Goal: review the branch.\nreview-scope: base:main\ncodex-effort: low\nORCH_BRIEF_END\n$(echo no)";
    const result = await runNode(HOOK, { stdin: JSON.stringify(call), env });

    const output = JSON.parse(result.stdout).hookSpecificOutput;
    const id = output.updatedInput.prompt.match(/^codex-request: (req-[0-9a-f]{12})$/m)[1];
    assert.ok(!output.updatedInput.prompt.includes("ORCH_BRIEF_END"), "the worker never sees the task text");
    assert.equal(output.updatedInput.subagent_type, "subagent-router:codex-reviewer");
    assert.equal(output.updatedInput.model, undefined, "an agreed route adds no model");
    assert.equal(output.additionalContext, undefined, "pure transport is not a routing change");

    const request = readRequest(tempDir, id);
    assert.deepEqual([request.kind, request.scope, request.effort, request.cwd], ["review", { type: "base", value: "main" }, "low", "/work/project"]);
    assert.equal(request.brief, call.tool_input.prompt);

    const [record] = readLog(tempDir);
    assert.deepEqual([record.action, record.codex_request], ["agree", id]);
    assert.ok(record.prompt.includes("Goal: review the branch."), "the log keeps the original task text");
  });
});

test("the transport also works in off mode and for calls from inside a subagent", async () => {
  await withJev({ body: jevBody() }, async ({ jev, tempDir, env }) => {
    const call = JSON.parse(agentCall());
    call.tool_input.subagent_type = "subagent-router:codex-implementer";
    const off = await runNode(HOOK, { stdin: JSON.stringify(call), env: { ...env, ORCH_MODE: "off" } });
    const nested = await runNode(HOOK, { stdin: JSON.stringify({ ...call, agent_id: "agent-1", agent_type: "general-purpose" }), env });
    for (const result of [off, nested]) {
      const updated = JSON.parse(result.stdout).hookSpecificOutput.updatedInput;
      assert.match(updated.prompt, /^codex-request: req-/);
      assert.equal(updated.subagent_type, "subagent-router:codex-implementer");
    }
    assert.equal(jev.state.requests.length, 0, "neither case asks Jev");
  });
});

test("a prompt that already carries a stored request is not wrapped again", async () => {
  await withJev({ body: jevBody({ kind: "implement", difficulty: 2.4 }) }, async ({ tempDir, env }) => {
    const first = await runNode(HOOK, { stdin: agentCall(), env });
    const prompt = JSON.parse(first.stdout).hookSpecificOutput.updatedInput.prompt;

    const again = JSON.parse(agentCall({ tool_use_id: "toolu_2" }));
    again.tool_input.subagent_type = "subagent-router:codex-implementer";
    again.tool_input.prompt = prompt;
    const second = await runNode(HOOK, { stdin: JSON.stringify(again), env: { ...env, ORCH_MODE: "off" } });
    assert.equal(second.stdout, "");
    assert.equal(fs.readdirSync(path.join(tempDir, "data", "codex-requests")).length, 1);
  });
});

test("a review after a failed Codex attempt still goes to Codex, because Claude wrote the change", async () => {
  await withJev({ body: jevBody({ kind: "implement", difficulty: 2.4 }) }, async ({ jev, tempDir, env }) => {
    // The hard task goes to Codex, and Codex fails without a change.
    await runNode(HOOK, { stdin: agentCall(), env });
    const log = "scripts/log-hook.mjs";
    await runNode(log, { env, stdin: JSON.stringify({ hook_event_name: "PostToolUse", session_id: "session-1", tool_name: "Agent", tool_use_id: "toolu_1", tool_input: { subagent_type: "subagent-router:codex-implementer", model: "haiku" }, tool_response: { status: "async_launched", agentId: "a1" } }) });
    await runNode(log, { env, stdin: JSON.stringify({ hook_event_name: "SubagentStop", session_id: "session-1", agent_id: "a1", agent_type: "subagent-router:codex-implementer", last_assistant_message: "CODEX_FAILED 20260101-000000-abcdef exit=1" }) });

    jev.state.reply = { body: jevBody({ kind: "review", writes: 0.02 }) };
    const review = JSON.parse(agentCall({ tool_use_id: "toolu_2" }));
    review.tool_input.subagent_type = "subagent-router:reviewer";
    const result = await runNode(HOOK, { stdin: JSON.stringify(review), env });
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.updatedInput.subagent_type, "subagent-router:codex-reviewer");
  });
});

test("an edit by the main session after a Codex change makes Claude the author, so the review stays with Codex", async () => {
  await withJev({ body: jevBody({ kind: "implement", difficulty: 2.4 }) }, async ({ jev, tempDir, env }) => {
    // Codex writes a change.
    await runNode(HOOK, { stdin: agentCall(), env });
    const log = "scripts/log-hook.mjs";
    await runNode(log, { env, stdin: JSON.stringify({ hook_event_name: "PostToolUse", session_id: "session-1", tool_name: "Agent", tool_use_id: "toolu_1", tool_input: { subagent_type: "subagent-router:codex-implementer", model: "haiku" }, tool_response: { status: "async_launched", agentId: "a1" } }) });
    await runNode(log, { env, stdin: JSON.stringify({ hook_event_name: "SubagentStop", session_id: "session-1", agent_id: "a1", agent_type: "subagent-router:codex-implementer", last_assistant_message: "CODEX_JOB 20260101-000000-abcdef exit=0\nChanged files: src/a.js" }) });

    // Then the main session edits a file itself. No worker is involved.
    const edit = await runNode("scripts/edit-hook.mjs", { env, stdin: JSON.stringify({ hook_event_name: "PostToolUse", session_id: "session-1", tool_name: "Edit", tool_input: { file_path: "src/b.js" }, tool_response: {} }) });
    assert.deepEqual([edit.code, edit.stdout], [0, ""], "the edit hook returns nothing");

    // The orchestrator asks Codex to review, as the delegate skill says. The last
    // author is Claude, so the table must not move the review to the Claude reviewer.
    jev.state.reply = { body: jevBody({ kind: "review", writes: 0.02 }) };
    const review = JSON.parse(agentCall({ tool_use_id: "toolu_2" }));
    review.tool_input.subagent_type = "subagent-router:codex-reviewer";
    await runNode(HOOK, { stdin: JSON.stringify(review), env });
    const record = readLog(tempDir).filter((entry) => entry.event === "dispatch").at(-1);
    assert.deepEqual([record.final.agent, record.reason], ["subagent-router:codex-reviewer", "codex_requested"]);
  });
});

test("the edit hook runs after every file tool, and skips other tools and other sessions' records", async () => {
  const hooks = JSON.parse(fs.readFileSync(new URL("../hooks/hooks.json", import.meta.url), "utf8"));
  const entry = hooks.hooks.PostToolUse.find((candidate) => candidate.hooks.some((hook) => hook.args.some((arg) => arg.endsWith("edit-hook.mjs"))));
  assert.ok(entry, "hooks.json registers the edit hook");
  for (const tool of ["Edit", "Write", "MultiEdit", "NotebookEdit"]) {
    assert.ok(new RegExp(`^(?:${entry.matcher})$`).test(tool), `the matcher covers ${tool}`);
  }
  assert.ok(!new RegExp(`^(?:${entry.matcher})$`).test("Read"));

  const tempDir = makeTempDir();
  try {
    const env = cleanEnv(tempDir);
    const call = (toolName, sessionId) => runNode("scripts/edit-hook.mjs", { env, stdin: JSON.stringify({ hook_event_name: "PostToolUse", session_id: sessionId, tool_name: toolName, tool_input: {} }) });
    await call("Read", "session-1");
    assert.ok(!fs.existsSync(path.join(tempDir, "data", "writers.jsonl")), "a tool that reads records nothing");
    await call("Write", "session-1");
    const { lastWriterFamily } = await import("../scripts/lib/context.mjs");
    const dataEnv = { ORCH_DATA_DIR: env.ORCH_DATA_DIR };
    assert.equal(lastWriterFamily("session-1", dataEnv), "claude");
    assert.equal(lastWriterFamily("session-2", dataEnv), null, "the record belongs to its own session");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("an agent type named like an inherited object key is not redirected and has no default model", async () => {
  await withJev({ body: jevBody() }, async ({ tempDir, env }) => {
    const call = JSON.parse(agentCall());
    call.tool_input.subagent_type = "constructor";
    const result = await runNode(HOOK, { stdin: JSON.stringify(call), env });
    // A lookup table with inherited keys would find a function for this name.
    const updated = JSON.parse(result.stdout).hookSpecificOutput.updatedInput;
    assert.deepEqual([updated.subagent_type, updated.model], ["constructor", "sonnet"]);
    const [record] = readLog(tempDir);
    assert.deepEqual([record.action, record.reason, record.model_only], ["rewrite", "implement", true]);
    assert.deepEqual(record.requested, { agent: "constructor", model: null });

    // With Codex off, the hook looks the agent type up in the table of Claude
    // counterparts. An inherited key there once removed the agent type from the call.
    const codexOff = await runNode(HOOK, { stdin: JSON.stringify({ ...call, tool_use_id: "toolu_2" }), env: { ...env, ORCH_CODEX_ENABLED: "" } });
    const output = JSON.parse(codexOff.stdout);
    assert.deepEqual([output.hookSpecificOutput.updatedInput.subagent_type, output.hookSpecificOutput.updatedInput.model], ["constructor", "sonnet"]);
    assert.equal(output.systemMessage, undefined, "no notice about Codex for a call that never asked for Codex");
    assert.deepEqual([readLog(tempDir)[1].action, readLog(tempDir)[1].final], ["rewrite", { agent: "constructor", model: "sonnet" }]);
  });
});

test("a writer or a reviewer is denied while a Codex job still changes files in the folder", async () => {
  await withJev({ body: jevBody({ kind: "implement", difficulty: 1 }) }, async ({ tempDir, env }) => {
    const project = path.join(tempDir, "project");
    fs.mkdirSync(project);
    const fakeCodex = path.join(tempDir, "fake-codex.cjs");
    fs.writeFileSync(
      fakeCodex,
      '#!/usr/bin/env node\nif (process.argv[2] === "login") { process.stderr.write("Logged in using ChatGPT\\n"); process.exit(0); }\nsetTimeout(() => {}, 30000);\n',
      { mode: 0o755 }
    );
    const codexEnv = { ...env, ORCH_CODEX_BIN: fakeCodex };
    const started = await runNode("scripts/orch-codex.mjs", { args: ["implement", "--wait", "0.5"], stdin: "Goal: long", env: codexEnv, cwd: project });
    const jobId = started.stdout.match(/^STILL_RUNNING (\S+)/)[1];

    const denied = await runNode(HOOK, { stdin: agentCall({ cwd: project }), env });
    const output = JSON.parse(denied.stdout).hookSpecificOutput;
    assert.equal(output.permissionDecision, "deny");
    assert.ok(output.permissionDecisionReason.includes(jobId));
    assert.deepEqual([readLog(tempDir)[0].action, readLog(tempDir)[0].busy_job], ["deny", jobId]);

    // Shadow mode never blocks, and another folder is not affected.
    const shadow = await runNode(HOOK, { stdin: agentCall({ cwd: project }), env: { ...env, ORCH_MODE: "shadow" } });
    const elsewhere = await runNode(HOOK, { stdin: agentCall({ cwd: tempDir }), env });
    assert.equal(shadow.stdout, "");
    assert.equal(elsewhere.stdout, "");

    await runNode("scripts/orch-codex.mjs", { args: ["cancel", jobId], env: codexEnv, cwd: project });
    const afterCancel = await runNode(HOOK, { stdin: agentCall({ cwd: project }), env });
    assert.equal(afterCancel.stdout, "", "the folder is free after the cancel");
  });
});

test("a key with a line break never reaches the log, also not inside an error text", async () => {
  await withJev({ body: jevBody() }, async ({ tempDir, env }) => {
    const key = "line-one-of-key\nline-two-of-key";
    const result = await runNode(HOOK, { stdin: agentCall(), env: { ...env, TYPESAFE_API_KEY: key } });
    assert.equal(result.stdout, "");
    const raw = fs.readFileSync(path.join(tempDir, "data", "dispatch-log.jsonl"), "utf8");
    assert.ok(!raw.includes("line-one-of-key") && !raw.includes("line-two-of-key"), raw);
    assert.equal(readLog(tempDir)[0].reason, "error_network");
  });
});

test("a key that an error body echoes across the cut at 300 characters never reaches the log", async () => {
  // The key starts at character 290, so a cut at 300 would keep its first 10 characters.
  const body = `${"x".repeat(290)}${TEST_KEY} was rejected`;
  await withJev({ status: 401, body }, async ({ tempDir, env }) => {
    const result = await runNode(HOOK, { stdin: agentCall(), env });
    assert.equal(result.stdout, "");
    const raw = fs.readFileSync(path.join(tempDir, "data", "dispatch-log.jsonl"), "utf8");
    assert.ok(raw.includes("http_401"), raw);
    assert.ok(!raw.includes(TEST_KEY.slice(0, 10)), "a part of the key reached the log");
  });
});

test("an internal error keeps the dispatch record, with the Jev answer and the error", async () => {
  await withJev({ body: jevBody({ kind: "review", writes: 0.02 }) }, async ({ tempDir, env }) => {
    // A folder where the writers index file should be makes the hook fail after the Jev call.
    fs.mkdirSync(path.join(tempDir, "data", "writers.jsonl"), { recursive: true });
    const result = await runNode(HOOK, { stdin: agentCall(), env });
    assert.deepEqual([result.code, result.stdout], [0, ""]);
    const [record] = readLog(tempDir);
    assert.deepEqual([record.event, record.action, record.reason, record.session_id], ["dispatch", "pass", "error_internal", "session-1"]);
    assert.equal(record.jev.kind, "review");
    assert.ok(record.error.message.length > 0 && record.error.stack.length > 0);
  });
});

test("while Codex has no capacity, reviews and hard tasks stay on Claude", async () => {
  await withJev({ body: jevBody({ kind: "review", writes: 0.02 }) }, async ({ jev, tempDir, env }) => {
    markCodexUnavailable("You've hit your usage limit.", { ORCH_DATA_DIR: env.ORCH_DATA_DIR });

    const review = JSON.parse(agentCall());
    review.tool_input.subagent_type = "subagent-router:codex-reviewer";
    const reviewResult = await runNode(HOOK, { stdin: JSON.stringify(review), env });
    assert.equal(JSON.parse(reviewResult.stdout).hookSpecificOutput.updatedInput.subagent_type, "subagent-router:reviewer");

    jev.state.reply = { body: jevBody({ kind: "implement", difficulty: 2.6 }) };
    const hard = await runNode(HOOK, { stdin: agentCall({ tool_use_id: "toolu_2" }), env });
    assert.equal(JSON.parse(hard.stdout).hookSpecificOutput.updatedInput.model, "opus");

    const [first, second] = readLog(tempDir);
    assert.deepEqual([first.reason, second.reason], ["codex_unavailable", "hard_needs_context"]);
    assert.deepEqual([first.codex.available, first.codex.reason], [false, "codex_reported_usage_limit"]);
    assert.equal(first.limits.state, "missing", "the log says why the limit rule had no value");
  });
});

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

test("a direct call to a Codex worker falls back to Claude, and the user is told once", async () => {
  // Jev is not confident here, so only the fallback rule can move the task.
  await withJev({ body: jevBody({ kind: "implement", confidence: 0.3 }) }, async ({ tempDir, env }) => {
    const resetsAt = Date.now() + 2 * 24 * 3600 * 1000;
    writeJson(path.join(tempDir, "data", "codex-limits.json"), { usedPercent: 100, resetsAt, creditsBalance: 57.8, hasCredits: true, ts: Date.now() });

    const call = JSON.parse(agentCall());
    call.tool_input.subagent_type = "subagent-router:codex-implementer";
    const first = JSON.parse((await runNode(HOOK, { stdin: JSON.stringify(call), env })).stdout);
    assert.deepEqual([first.hookSpecificOutput.updatedInput.subagent_type, first.hookSpecificOutput.updatedInput.model], ["subagent-router:implementer", "sonnet"]);
    assert.equal(first.hookSpecificOutput.updatedInput.prompt, call.tool_input.prompt, "a Claude worker gets the real task text");
    assert.match(first.systemMessage, /weekly Codex allowance[\s\S]*run on Claude workers/);
    assert.match(first.hookSpecificOutput.additionalContext, /codex_plan_used_up/);

    const second = JSON.parse((await runNode(HOOK, { stdin: JSON.stringify({ ...call, tool_use_id: "toolu_2" }), env })).stdout);
    assert.equal(second.systemMessage, undefined, "one notice per session is enough");
    assert.equal(second.hookSpecificOutput.updatedInput.subagent_type, "subagent-router:implementer");

    const otherSession = JSON.parse((await runNode(HOOK, { stdin: JSON.stringify({ ...call, session_id: "session-2" }), env })).stdout);
    assert.ok(otherSession.systemMessage, "a new session is told again");

    const [record] = readLog(tempDir);
    assert.deepEqual([record.action, record.reason, record.codex.used_percent], ["fallback", "codex_plan_used_up", 100]);
    assert.ok(!fs.existsSync(path.join(tempDir, "data", "codex-requests")), "no Codex request is stored for a task that runs on Claude");
  });
});

test("with codexSpendCredits the used-up plan does not stop Codex, and shadow mode never falls back", async () => {
  await withJev({ body: jevBody({ kind: "implement", confidence: 0.3 }) }, async ({ tempDir, env }) => {
    writeJson(path.join(tempDir, "data", "codex-limits.json"), { usedPercent: 100, resetsAt: Date.now() + 3600 * 1000, ts: Date.now() });
    const call = JSON.parse(agentCall());
    call.tool_input.subagent_type = "subagent-router:codex-implementer";

    const shadow = JSON.parse((await runNode(HOOK, { stdin: JSON.stringify(call), env: { ...env, ORCH_MODE: "shadow" } })).stdout);
    assert.equal(shadow.hookSpecificOutput.updatedInput.subagent_type, "subagent-router:codex-implementer");

    writeJson(path.join(tempDir, "data", "config.json"), { codexSpendCredits: true });
    const allowed = JSON.parse((await runNode(HOOK, { stdin: JSON.stringify({ ...call, tool_use_id: "toolu_2" }), env })).stdout);
    assert.equal(allowed.hookSpecificOutput.updatedInput.subagent_type, "subagent-router:codex-implementer");
    assert.equal(allowed.systemMessage, undefined);
  });
});

test("numbers from before the reset time say nothing, so Codex counts as available again", async () => {
  await withJev({ body: jevBody({ kind: "implement", confidence: 0.3 }) }, async ({ tempDir, env }) => {
    writeJson(path.join(tempDir, "data", "codex-limits.json"), { usedPercent: 100, resetsAt: Date.now() - 1000, ts: Date.now() - 5000 });
    const call = JSON.parse(agentCall());
    call.tool_input.subagent_type = "subagent-router:codex-implementer";
    const result = JSON.parse((await runNode(HOOK, { stdin: JSON.stringify(call), env })).stdout);
    assert.equal(result.hookSpecificOutput.updatedInput.subagent_type, "subagent-router:codex-implementer");
  });
});

test("the pace rule moves work to Codex below the gate, tells the user why, and records the projection", async () => {
  await withJev({ body: jevBody({ kind: "implement", difficulty: 1 }) }, async ({ tempDir, env }) => {
    const limitsFile = path.join(tempDir, "limits-latest.json");
    const withLimits = { ...env, ORCH_LIMITS_FILE: limitsFile };
    const ts = Math.floor(Date.now() / 1000);
    const sevenDays = 7 * 24 * 3600;
    // The control: 50 percent of the 5-hour window after 4 hours, so 1 hour left, is on pace for 62.5, rounded to 63. Not tight.
    writeJson(limitsFile, { ts, five_hour: 50, seven_day: 10, five_hour_resets_at: ts + 3600, seven_day_resets_at: ts + sevenDays - 86400, session_id: "s" });
    const calm = await runNode(HOOK, { stdin: agentCall({ session_id: "session-calm" }), env: withLimits });
    assert.equal(calm.stdout, "");
    const [calmRecord] = readLog(tempDir);
    assert.deepEqual([calmRecord.claude.tight, calmRecord.claude.reason, calmRecord.claude.windows.fiveHour.projected], [false, null, 63]);

    // The same 50 percent after only 2 hours, so 3 hours left, is on pace for 125: tight.
    writeJson(limitsFile, { ts, five_hour: 50, seven_day: 10, five_hour_resets_at: ts + 3 * 3600, seven_day_resets_at: ts + sevenDays - 86400, session_id: "s" });
    const paced = JSON.parse((await runNode(HOOK, { stdin: agentCall({ session_id: "session-paced" }), env: withLimits })).stdout);
    assert.equal(paced.hookSpecificOutput.updatedInput.subagent_type, "subagent-router:codex-implementer");
    assert.match(paced.systemMessage, /^Claude usage is at 50% of the 5-hour window and 10% of the 7-day window\. At this pace the 5-hour window runs out before it resets at .+ \(about 125% by then\)\. Tasks with a complete brief now run on Codex/);
    const pacedRecord = readLog(tempDir)[1];
    assert.deepEqual([pacedRecord.action, pacedRecord.reason, pacedRecord.claude.tight, pacedRecord.claude.reason], ["rewrite", "limit_rule", true, "pace"]);
    assert.deepEqual([pacedRecord.claude.windows.fiveHour.projected, pacedRecord.claude.windows.fiveHour.elapsedShare], [125, 0.4]);

    // With the switch off, the same numbers move nothing.
    fs.mkdirSync(path.join(tempDir, "data"), { recursive: true });
    writeJson(path.join(tempDir, "data", "config.json"), { pacing: false });
    const off = await runNode(HOOK, { stdin: agentCall({ session_id: "session-off" }), env: withLimits });
    assert.equal(off.stdout, "");
    assert.deepEqual([readLog(tempDir)[2].claude.tight, readLog(tempDir)[2].claude.windows.fiveHour.projected], [false, null]);
  });
});

test("high Claude usage moves complete tasks to Codex and tells the user once, unless Codex is tight too", async () => {
  await withJev({ body: jevBody({ kind: "implement", difficulty: 1 }) }, async ({ tempDir, env }) => {
    const limitsFile = path.join(tempDir, "limits-latest.json");
    writeJson(limitsFile, { ts: Math.floor(Date.now() / 1000), five_hour: 86.4, seven_day: 54 });
    const withLimits = { ...env, ORCH_LIMITS_FILE: limitsFile };

    const first = JSON.parse((await runNode(HOOK, { stdin: agentCall(), env: withLimits })).stdout);
    assert.equal(first.hookSpecificOutput.updatedInput.subagent_type, "subagent-router:codex-implementer");
    assert.match(first.systemMessage, /Claude usage is at 86% of the 5-hour window and 54% of the 7-day window/);

    // Codex is tight as well: moving work there would only move the problem.
    writeJson(path.join(tempDir, "data", "codex-limits.json"), { usedPercent: 91, resetsAt: Date.now() + 3600 * 1000, ts: Date.now() });
    const both = await runNode(HOOK, { stdin: agentCall({ session_id: "session-3" }), env: withLimits });
    assert.equal(both.stdout, "", "the task keeps its normal route on Claude");
  });
});

// Makes a Codex job hold the writer lock of `folder`, the same way that orch-codex.mjs does.
// The lock is fresh and names this test process as its starter, which holds the
// folder. (Its runner.pid is this process too, but a runner counts only when its
// command line names the job, and this one does not.) The returned function ends the job.
function holdWriterLock(env, folder) {
  const jobId = "20260921-120000-a1b2c3";
  const jobDir = path.join(jobsDir(env), jobId);
  fs.mkdirSync(jobDir, { recursive: true });
  assert.equal(acquireWriterLock(folder, jobId, env), null);
  fs.writeFileSync(path.join(jobDir, "runner.pid"), String(process.pid));
  // An exit code means that the job is done, so the folder is free again.
  return () => fs.writeFileSync(path.join(jobDir, "exit-code"), "0");
}

test("a call that the writer lock denies does not use up the notice about Codex", async () => {
  // Jev is not confident, so only the fallback rule moves the task.
  await withJev({ body: jevBody({ kind: "review", confidence: 0.3 }) }, async ({ tempDir, env }) => {
    markCodexUnavailable("You've hit your usage limit.", env);
    const project = path.join(tempDir, "project");
    fs.mkdirSync(project);
    const endJob = holdWriterLock(env, project);

    const call = JSON.parse(agentCall({ cwd: project }));
    call.tool_input.subagent_type = "subagent-router:codex-reviewer";
    const denied = JSON.parse((await runNode(HOOK, { stdin: JSON.stringify(call), env })).stdout);
    assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
    assert.equal(denied.systemMessage, undefined, "the deny output shows no notice");

    endJob();
    const next = JSON.parse((await runNode(HOOK, { stdin: JSON.stringify({ ...call, tool_use_id: "toolu_2" }), env })).stdout);
    assert.equal(next.hookSpecificOutput.updatedInput.subagent_type, "subagent-router:reviewer");
    assert.match(next.systemMessage, /no capacity left[\s\S]*run on Claude workers/, "the first call that runs shows the notice");

    const [first, second] = readLog(tempDir);
    assert.deepEqual([first.action, first.notice], ["deny", undefined], "the log names no notice for a call that showed none");
    assert.deepEqual([second.action, second.notice], ["fallback", next.systemMessage]);
  });
});

test("a call that the writer lock denies does not use up the notice about Claude usage", async () => {
  await withJev({ body: jevBody({ kind: "implement", difficulty: 1 }) }, async ({ tempDir, env }) => {
    const limitsFile = path.join(tempDir, "limits-latest.json");
    writeJson(limitsFile, { ts: Math.floor(Date.now() / 1000), five_hour: 86.4, seven_day: 54 });
    const withLimits = { ...env, ORCH_LIMITS_FILE: limitsFile };
    const project = path.join(tempDir, "project");
    fs.mkdirSync(project);
    const endJob = holdWriterLock(env, project);

    const denied = JSON.parse((await runNode(HOOK, { stdin: agentCall({ cwd: project }), env: withLimits })).stdout);
    assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
    assert.equal(denied.systemMessage, undefined, "the deny output shows no notice");

    endJob();
    const next = JSON.parse((await runNode(HOOK, { stdin: agentCall({ cwd: project, tool_use_id: "toolu_2" }), env: withLimits })).stdout);
    assert.equal(next.hookSpecificOutput.updatedInput.subagent_type, "subagent-router:codex-implementer");
    assert.match(next.systemMessage, /Claude usage is at 86% of the 5-hour window/, "the first call that runs shows the notice");
  });
});

test("an agent type of another owner is denied while a Codex job writes, when Jev says that its task changes files", async () => {
  await withJev({ body: jevBody({ kind: "implement", writes: 0.95 }) }, async ({ jev, tempDir, env }) => {
    const project = path.join(tempDir, "project");
    fs.mkdirSync(project);
    const endJob = holdWriterLock(env, project);
    const call = (subagentType, toolUseId) => {
      const value = JSON.parse(agentCall({ cwd: project, tool_use_id: toolUseId }));
      value.tool_input.subagent_type = subagentType;
      return JSON.stringify(value);
    };

    const writer = JSON.parse((await runNode(HOOK, { stdin: call("general-purpose", "toolu_1"), env })).stdout).hookSpecificOutput;
    assert.equal(writer.permissionDecision, "deny");
    assert.ok(writer.permissionDecisionReason.includes("20260921-120000-a1b2c3"), writer.permissionDecisionReason);

    // A task that only reads does not wait, whatever the agent type.
    jev.state.reply = { body: jevBody({ kind: "search", writes: 0.03 }) };
    const reader = JSON.parse((await runNode(HOOK, { stdin: call("general-purpose", "toolu_2"), env })).stdout).hookSpecificOutput;
    assert.equal(reader.permissionDecision, undefined);
    assert.equal(reader.updatedInput.subagent_type, "general-purpose", "the call runs, with only its model set");

    // Without a Jev answer nothing is known about the task, and the call passes.
    jev.state.reply = { status: 500, body: "{}" };
    const unknown = await runNode(HOOK, { stdin: call("general-purpose", "toolu_3"), env });
    assert.equal(unknown.stdout, "");

    const [denied, read, failed] = readLog(tempDir);
    assert.deepEqual([denied.action, denied.reason], ["deny", "codex_writer_busy"]);
    assert.notEqual(read.action, "deny");
    assert.equal(failed.action, "pass");

    // The plugin's own writer is still denied, and the folder is free once the job has ended.
    assert.equal(JSON.parse((await runNode(HOOK, { stdin: call("subagent-router:implementer", "toolu_4"), env })).stdout).hookSpecificOutput.permissionDecision, "deny");
    endJob();
    jev.state.reply = { body: jevBody({ kind: "implement", writes: 0.95 }) };
    const after = await runNode(HOOK, { stdin: call("general-purpose", "toolu_5"), env });
    assert.ok(!after.stdout.includes('"deny"'), after.stdout);
  });
});

test("a lock that cannot be read denies with its path, not with a wait command for the job id unknown", async () => {
  await withJev({ body: jevBody({ kind: "implement" }) }, async ({ tempDir, env }) => {
    const project = path.join(tempDir, "project");
    fs.mkdirSync(project);
    holdWriterLock(env, project);
    // The state that another start would see in the middle of a write.
    fs.writeFileSync(writerLockPath(project, env), "");

    const output = JSON.parse((await runNode(HOOK, { stdin: agentCall({ cwd: project }), env })).stdout).hookSpecificOutput;
    assert.equal(output.permissionDecision, "deny");
    assert.ok(!output.permissionDecisionReason.includes("wait unknown"), output.permissionDecisionReason);
    assert.ok(output.permissionDecisionReason.includes(writerLockPath(project, env)), output.permissionDecisionReason);
    assert.equal(readLog(tempDir)[0].busy_job, "unknown");
  });
});

test("with Codex off, no task reaches Codex and codex-rescue passes unchanged", async () => {
  await withJev({ body: jevBody({ kind: "implement", difficulty: 2.6 }) }, async ({ jev, tempDir, env }) => {
    const off = { ...env, ORCH_CODEX_ENABLED: "" };
    // Claude is tight, so with Codex on the limit rule would pick Codex.
    const limitsFile = path.join(tempDir, "limits-latest.json");
    writeJson(limitsFile, { ts: Math.floor(Date.now() / 1000), five_hour: 95, seven_day: 90 });
    const offTight = { ...off, ORCH_LIMITS_FILE: limitsFile };

    // The hard task stays on the implementer. Sonnet is the upper limit while Claude is
    // tight, and Sonnet is what the call asked for, so nothing changes and nobody is told.
    const hard = await runNode(HOOK, { stdin: agentCall(), env: offTight });
    assert.equal(hard.stdout, "");

    jev.state.reply = { body: jevBody({ kind: "review", writes: 0.02 }) };
    const review = JSON.parse(agentCall({ tool_use_id: "toolu_2" }));
    review.tool_input.subagent_type = "subagent-router:reviewer";
    const reviewResult = await runNode(HOOK, { stdin: JSON.stringify(review), env: offTight });
    assert.equal(reviewResult.stdout, "", "the review stays on the Claude reviewer, and the user is not told again and again that Codex is off");

    // Jev is not confident here, so only the fallback rule can move the task.
    jev.state.reply = { body: jevBody({ kind: "implement", confidence: 0.3 }) };
    const direct = JSON.parse(agentCall({ tool_use_id: "toolu_3" }));
    direct.tool_input.subagent_type = "subagent-router:codex-implementer";
    const directResult = JSON.parse((await runNode(HOOK, { stdin: JSON.stringify(direct), env: offTight })).stdout);
    assert.equal(directResult.hookSpecificOutput.updatedInput.subagent_type, "subagent-router:implementer");
    assert.match(directResult.systemMessage, /^Codex is off, because "codexEnabled" is not true/);
    const again = JSON.parse((await runNode(HOOK, { stdin: JSON.stringify({ ...direct, tool_use_id: "toolu_4" }), env: offTight })).stdout);
    assert.equal(again.systemMessage, undefined, "one notice per session is enough");

    // A direct call to the Codex reviewer reaches the Claude reviewer through the table.
    // It is still a call for Codex, so a new session is told.
    jev.state.reply = { body: jevBody({ kind: "review", writes: 0.02 }) };
    const directReview = JSON.parse(agentCall({ tool_use_id: "toolu_6", session_id: "session-2" }));
    directReview.tool_input.subagent_type = "subagent-router:codex-reviewer";
    const directReviewResult = JSON.parse((await runNode(HOOK, { stdin: JSON.stringify(directReview), env: off })).stdout);
    assert.equal(directReviewResult.hookSpecificOutput.updatedInput.subagent_type, "subagent-router:reviewer");
    assert.match(directReviewResult.systemMessage, /^Codex is off/);

    const requestsBefore = jev.state.requests.length;
    const rescue = JSON.parse(agentCall({ tool_use_id: "toolu_5" }));
    rescue.tool_input.subagent_type = "codex:codex-rescue";
    const rescueResult = await runNode(HOOK, { stdin: JSON.stringify(rescue), env: off });
    assert.equal(rescueResult.stdout, "", "the Codex plugin's own agent runs as the user asked");
    assert.equal(jev.state.requests.length, requestsBefore);

    const log = readLog(tempDir);
    assert.deepEqual(log.map((record) => record.reason), ["claude_tight", "codex_unavailable", "codex_disabled", "codex_disabled", "codex_unavailable", "codex_disabled"]);
    assert.deepEqual([log[0].action, log[0].final], ["agree", { agent: "subagent-router:implementer", model: null }]);
    assert.deepEqual([log[0].codex.available, log[0].codex.reason], [false, "codex_disabled"]);
    assert.ok(!fs.existsSync(path.join(tempDir, "data", "codex-requests")), "no Codex request was stored");
  });
});

test("while Claude usage is high and Codex cannot take work, Opus becomes Sonnet and the user is told once", async () => {
  await withJev({ body: jevBody({ kind: "debug", writes: 0.6 }) }, async ({ jev, tempDir, env }) => {
    const limitsFile = path.join(tempDir, "limits-latest.json");
    writeJson(limitsFile, { ts: Math.floor(Date.now() / 1000), five_hour: 95, seven_day: 90 });
    const offTight = { ...env, ORCH_CODEX_ENABLED: "", ORCH_LIMITS_FILE: limitsFile };
    const debug = JSON.parse(agentCall());
    debug.tool_input.subagent_type = "subagent-router:debugger";

    // The control: with free room the debugger keeps its model, so the hook prints nothing.
    const free = await runNode(HOOK, { stdin: JSON.stringify({ ...debug, session_id: "session-free" }), env: { ...env, ORCH_CODEX_ENABLED: "" } });
    assert.equal(free.stdout, "");

    const first = JSON.parse((await runNode(HOOK, { stdin: JSON.stringify(debug), env: offTight })).stdout);
    assert.deepEqual([first.hookSpecificOutput.updatedInput.subagent_type, first.hookSpecificOutput.updatedInput.model], ["subagent-router:debugger", "sonnet"]);
    assert.match(first.systemMessage, /Claude usage is at 95% of the 5-hour window and 90% of the 7-day window\. Codex cannot take work, so tasks that would run on Opus now run on Sonnet/);

    // Another agent type gets the same upper limit, and one notice per session is enough.
    jev.state.reply = { body: jevBody({ kind: "implement", difficulty: 2.6 }) };
    const second = JSON.parse((await runNode(HOOK, { stdin: JSON.stringify(otherAgentCall("dotnet-implementer", {}, { tool_use_id: "toolu_2" })), env: offTight })).stdout);
    assert.deepEqual([second.hookSpecificOutput.updatedInput.subagent_type, second.hookSpecificOutput.updatedInput.model], ["dotnet-implementer", "sonnet"]);
    assert.equal(second.systemMessage, undefined);

    const [control, capped, cappedOther] = readLog(tempDir);
    assert.deepEqual([control.action, control.reason], ["agree", "debug"]);
    assert.deepEqual([capped.action, capped.reason, capped.notice], ["rewrite", "claude_tight", first.systemMessage]);
    assert.equal(capped.model_only, undefined, "the debugger is one of our workers, so its record has no such mark");
    assert.deepEqual([cappedOther.action, cappedOther.reason, cappedOther.model_only], ["rewrite", "claude_tight", true]);
  });
});

test("a review that the hook moves to Codex keeps its brief as custom review instructions", async () => {
  await withJev({ body: jevBody({ kind: "review", writes: 0.02 }) }, async ({ tempDir, env }) => {
    const reviewCall = (agent, prompt, toolUseId, model) => {
      const call = JSON.parse(agentCall({ tool_use_id: toolUseId }));
      call.cwd = "/work/project";
      call.tool_input = { ...call.tool_input, subagent_type: agent, prompt, ...(model ? { model } : {}) };
      return call;
    };
    const requestOf = (result) => readRequest(tempDir, JSON.parse(result.stdout).hookSpecificOutput.updatedInput.prompt.match(/^codex-request: (req-[0-9a-f]{12})$/m)[1]);

    // Asked for the Claude reviewer, moved to the Codex reviewer: the brief must not be lost.
    const moved = await runNode(HOOK, { stdin: JSON.stringify(reviewCall("subagent-router:reviewer", "Goal: review the whole project for security problems.", "toolu_1")), env });
    assert.equal(JSON.parse(moved.stdout).hookSpecificOutput.updatedInput.subagent_type, "subagent-router:codex-reviewer");
    const movedRequest = requestOf(moved);
    assert.deepEqual([movedRequest.scope, movedRequest.scope_source], [{ type: "custom" }, "routing"]);
    assert.ok(sendsBriefToCodex({ kind: "review", scope: movedRequest.scope }), "Codex reads the brief");
    assert.equal(movedRequest.brief, "Goal: review the whole project for security problems.");

    // Asked for the Codex reviewer directly: the documented default stays, the uncommitted changes.
    const direct = await runNode(HOOK, { stdin: JSON.stringify(reviewCall("subagent-router:codex-reviewer", "Goal: review my changes.", "toolu_2")), env });
    const directRequest = requestOf(direct);
    assert.deepEqual([directRequest.scope, directRequest.scope_source], [{ type: "uncommitted" }, "default"]);
    assert.ok(!sendsBriefToCodex({ kind: "review", scope: directRequest.scope }));

    // A direct call whose only change is the model is not a move.
    const modelOnly = await runNode(HOOK, { stdin: JSON.stringify(reviewCall("subagent-router:codex-reviewer", "Goal: review my changes.", "toolu_3", "sonnet")), env });
    assert.equal(JSON.parse(modelOnly.stdout).hookSpecificOutput.updatedInput.model, "haiku");
    assert.equal(requestOf(modelOnly).scope.type, "uncommitted");

    // A scope line in the brief wins over both defaults.
    const scoped = await runNode(HOOK, { stdin: JSON.stringify(reviewCall("subagent-router:reviewer", "Goal: review the branch.\nreview-scope: base:main", "toolu_4")), env });
    assert.equal(JSON.parse(scoped.stdout).hookSpecificOutput.updatedInput.subagent_type, "subagent-router:codex-reviewer");
    assert.deepEqual([requestOf(scoped).scope, requestOf(scoped).scope_source], [{ type: "base", value: "main" }, "brief"]);

    assert.deepEqual(readLog(tempDir).map((record) => record.review_scope), ["custom", "uncommitted", "uncommitted", "base:main"]);
  });
});
