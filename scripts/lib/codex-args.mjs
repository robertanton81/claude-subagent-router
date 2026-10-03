// Builds and checks the arguments for the Codex CLI.
// All values go to `spawn` as an argument list, never through a shell.

export const EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);

export const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
// SHA-1 ids have 40 hex characters, SHA-256 ids 64.
export const COMMIT_PATTERN = /^[0-9a-fA-F]{7,64}$/;

export const RESULT_CONTRACT = [
  "",
  "---",
  "When you finish, end your answer with these lines:",
  "Changed files: <list of paths, or \"none\">",
  "Verification: <the command you ran and its final result, or \"not run\" with the reason; runs that failed before your change do not go here>",
  "Open problems: <list, or \"none\">",
  "If the task above asks for more lines, such as Reproduction: and Cause:, put them after Open problems.",
  ""
].join("\n");

// A custom review and a consult run as plain `codex exec`, and only the final
// message of Codex comes back. So the brief says so, and a model that writes its
// answer in an earlier message and ends with a short line is warned.
const FINAL_MESSAGE_RULE =
  "This task is read-only: do not change any file. Only your final message reaches the caller; earlier messages are lost. Put your whole answer in the final message, and do not point to an earlier message.";

export const REVIEW_CONTRACT = [
  "",
  "---",
  FINAL_MESSAGE_RULE,
  "If the task above names an answer format, use it. Otherwise list the findings, the most severe first. Give each finding the file and line, what goes wrong and when, and a small fix. End with one line that says whether the change is correct.",
  "In every format, tag each new finding with its priority by the harm it causes: [P0] breaks the build or loses data, [P1] a bug that users will hit, [P2] a bug in a rare case, [P3] a minor problem. A finding that the task above lists as already known goes on one line under Known:, without a tag. Say plainly when you found nothing.",
  ""
].join("\n");

export const CONSULT_CONTRACT = ["", "---", FINAL_MESSAGE_RULE, ""].join("\n");

export const JOB_KINDS = new Set(["implement", "review", "consult"]);

export class UsageError extends Error {}

// Reads the flags after the command word. Returns a plain options object.
export function parseOptions(argv) {
  const options = { model: null, effort: null, waitSeconds: null, scope: null, positionals: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) {
        throw new UsageError(`${arg} needs a value`);
      }
      return argv[index];
    };
    switch (arg) {
      case "--model":
        options.model = next();
        if (!MODEL_PATTERN.test(options.model)) {
          throw new UsageError("--model has characters that are not allowed");
        }
        break;
      case "--effort":
        options.effort = next();
        if (!EFFORTS.has(options.effort)) {
          throw new UsageError(`--effort must be one of: ${[...EFFORTS].join(", ")}`);
        }
        break;
      case "--wait": {
        const seconds = Number(next());
        if (!Number.isFinite(seconds) || seconds < 0 || seconds > 570) {
          throw new UsageError("--wait must be a number of seconds from 0 to 570");
        }
        options.waitSeconds = seconds;
        break;
      }
      case "--uncommitted":
        options.scope = { type: "uncommitted" };
        break;
      case "--custom":
        options.scope = { type: "custom" };
        break;
      case "--base": {
        const branch = next();
        if (!BRANCH_PATTERN.test(branch)) {
          throw new UsageError("--base has characters that are not allowed");
        }
        options.scope = { type: "base", value: branch };
        break;
      }
      case "--commit": {
        const sha = next();
        if (!COMMIT_PATTERN.test(sha)) {
          throw new UsageError("--commit must be a commit hash of 7 to 64 hex characters");
        }
        options.scope = { type: "commit", value: sha };
        break;
      }
      default:
        if (arg.startsWith("--")) {
          throw new UsageError(`unknown option ${arg}`);
        }
        options.positionals.push(arg);
    }
  }
  return options;
}

function modelArgs(job) {
  const args = [];
  if (job.model) {
    args.push("-m", job.model);
  }
  if (job.effort) {
    args.push("-c", `model_reasoning_effort=${job.effort}`);
  }
  return args;
}

// Codex refuses a prompt together with a scope flag:
//   "the argument '--uncommitted' cannot be used with '[PROMPT]'"
// So a review has two forms. A scoped review names the diff, and Codex uses its
// own review rules. A custom review sends the task text and no scope flag.
export function sendsBriefToCodex(job) {
  return job.kind === "implement" || job.kind === "consult" || (job.kind === "review" && job.scope?.type === "custom");
}

// A custom review and a consult run as plain `codex exec` in a read-only
// sandbox, not as `codex exec review`. The review command runs the review in a
// second Codex thread that must end with a JSON verdict (findings and a short
// explanation). Only that verdict reaches the result file and the JSON events.
// Text that does not fit the verdict is lost: a design answer of 19,470
// characters came back as a verdict of 282 (codex-cli 0.154.0). The review
// command also replaces an answer format that the brief asks for.
export function runsReadOnlyExec(job) {
  return job.kind === "consult" || (job.kind === "review" && job.scope?.type === "custom");
}

// The text that the runner adds to the brief of a job, after the task.
export function briefContract(job) {
  if (job.kind === "implement") {
    return RESULT_CONTRACT;
  }
  if (job.kind === "consult") {
    return CONSULT_CONTRACT;
  }
  return runsReadOnlyExec(job) ? REVIEW_CONTRACT : "";
}

function scopeArgs(scope) {
  switch (scope?.type) {
    case "base":
      return ["--base", scope.value];
    case "commit":
      return ["--commit", scope.value];
    default:
      return ["--uncommitted"];
  }
}

// The argument list for `codex`. When Codex gets the brief, it arrives on stdin ("-").
export function buildCodexArgs(job, resultPath) {
  if (!JOB_KINDS.has(job.kind)) {
    throw new UsageError(`unknown job kind ${job.kind}`);
  }
  // Command-line overrides win over a user's permissive defaults. Only an
  // implement job may write, and only in its workspace. Every other kind reads.
  const sandbox = job.kind === "implement" ? "workspace-write" : "read-only";
  const boundary = ["-c", 'approval_policy="never"', "-c", `sandbox_mode="${sandbox}"`,
    "-c", "sandbox_workspace_write.network_access=false", "-c", "sandbox_workspace_write.writable_roots=[]",
    "-c", "sandbox_workspace_write.exclude_slash_tmp=true", "-c", "sandbox_workspace_write.exclude_tmpdir_env_var=true"];
  if (sendsBriefToCodex(job)) {
    return ["exec", "-s", sandbox, "--json", "-o", resultPath, ...modelArgs(job), ...boundary, "-"];
  }
  return ["exec", "review", ...scopeArgs(job.scope), "--json", "-o", resultPath, ...modelArgs(job), ...boundary];
}
