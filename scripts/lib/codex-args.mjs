// Builds and checks the arguments for the Codex CLI.
// All values go to `spawn` as an argument list, never through a shell.

export const EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);

export const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
export const COMMIT_PATTERN = /^[0-9a-fA-F]{7,40}$/;

export const RESULT_CONTRACT = [
  "",
  "---",
  "When you finish, answer in exactly this format:",
  "Changed files: <list of paths, or \"none\">",
  "Verification: <the command you ran and its result, or \"not run\" with the reason>",
  "Open problems: <list, or \"none\">",
  ""
].join("\n");

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
          throw new UsageError("--commit must be a commit hash of 7 to 40 hex characters");
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
  return job.kind === "implement" || (job.kind === "review" && job.scope?.type === "custom");
}

function scopeArgs(scope) {
  switch (scope?.type) {
    case "custom":
      return [];
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
  // Command-line overrides win over a user's permissive defaults. The review
  // has no write permission; implementation can write only its workspace.
  const boundary = ["-c", 'approval_policy="never"', "-c", `sandbox_mode="${job.kind === "review" ? "read-only" : "workspace-write"}"`,
    "-c", "sandbox_workspace_write.network_access=false", "-c", "sandbox_workspace_write.writable_roots=[]",
    "-c", "sandbox_workspace_write.exclude_slash_tmp=true", "-c", "sandbox_workspace_write.exclude_tmpdir_env_var=true"];
  if (job.kind === "implement") {
    return ["exec", "-s", "workspace-write", "--json", "-o", resultPath, ...modelArgs(job), ...boundary, "-"];
  }
  if (job.kind === "review") {
    const args = ["exec", "review", ...scopeArgs(job.scope), "--json", "-o", resultPath, ...modelArgs(job), ...boundary];
    if (sendsBriefToCodex(job)) {
      args.push("-");
    }
    return args;
  }
  throw new UsageError(`unknown job kind ${job.kind}`);
}
