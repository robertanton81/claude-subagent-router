import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function makeTempDir(prefix = "orch-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// A clean environment for child processes. HOME points at a temp folder, so a
// test can never read the real log or the real settings.
export function cleanEnv(tempDir, extra = {}) {
  return {
    PATH: process.env.PATH,
    HOME: tempDir,
    ORCH_DATA_DIR: path.join(tempDir, "data"),
    // Codex is off by default. Most tests are about Codex, so they turn it on.
    // A test of the default passes ORCH_CODEX_ENABLED: "" in `extra`.
    ORCH_CODEX_ENABLED: "1",
    // Jev is off by default too. Most tests are about routing, so they turn it on.
    // A test of the default passes ORCH_JEV_ENABLED: "" in `extra`.
    ORCH_JEV_ENABLED: "1",
    ...extra
  };
}

export function runNode(script, { args = [], stdin = "", env, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, script), ...args], { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

export function readLog(tempDir) {
  const file = path.join(tempDir, "data", "dispatch-log.jsonl");
  if (!fs.existsSync(file)) {
    return [];
  }
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function jevBody({ kind = "implement", confidence = 0.9, writes = 0.95, selfContained = 0.9, difficulty = 1, needsEveryMatch = 0.1 } = {}) {
  return {
    model: "jev-test",
    answers: {
      kind: { type: "choice", choice: kind, probabilities: { [kind]: 1 }, confidence },
      writes_files: { type: "noul", noul: writes },
      self_contained: { type: "noul", noul: selfContained },
      difficulty: { type: "score", score: difficulty, confidence: 0.8, legend: {}, probabilities: {} },
      needs_every_match: { type: "noul", noul: needsEveryMatch }
    },
    usage: { input_tokens: 400, output_tokens: 40 }
  };
}

// A local stand-in for the TypeSafe API. `reply` can change between requests.
export async function startFakeJev(initialReply) {
  const state = { reply: initialReply, requests: [] };
  const server = http.createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      state.requests.push({ headers: request.headers, body: raw ? JSON.parse(raw) : null });
      const reply = state.reply;
      setTimeout(() => {
        response.writeHead(reply.status ?? 200, { "Content-Type": "application/json" });
        response.end(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body));
      }, reply.delayMs ?? 0);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    state,
    url: `http://127.0.0.1:${server.address().port}/v1/systemone`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

export function agentCall(overrides = {}) {
  return JSON.stringify({
    session_id: "session-1",
    hook_event_name: "PreToolUse",
    tool_name: "Agent",
    tool_use_id: "toolu_1",
    tool_input: {
      description: "Add retry",
      prompt: "Goal: add a retry to the fetch helper.",
      subagent_type: "orchestrator:implementer",
      run_in_background: true
    },
    ...overrides
  });
}
