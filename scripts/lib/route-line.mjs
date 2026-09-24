// The line `orch-route: keep` in a brief. It tells the routing hook to run the
// call exactly as the orchestrator wrote it: the same worker and the same model.
//
// Why it exists: Jev sees only the brief. When a worker was blocked on a small
// model and the orchestrator starts the same brief again on a bigger one, Jev
// would pick the small model again. This line lets the retry stay on its model.
//
// The brief is not trusted text. That is safe here, because the line can only
// make the hook do less: it never picks a worker, a model or a command.

const ROUTE_LINE = /^[ \t]*orch-route:[ \t]*(.*?)[ \t]*$/im;

// Returns { keep, warning }. A value other than "keep" counts as no line, and
// the warning goes into the dispatch log.
export function readRouteLine(prompt) {
  const match = typeof prompt === "string" ? prompt.match(ROUTE_LINE) : null;
  if (!match) {
    return { keep: false, warning: null };
  }
  if (match[1].toLowerCase() === "keep") {
    return { keep: true, warning: null };
  }
  return { keep: false, warning: `the line orch-route has "${match[1].slice(0, 40)}", which is not keep, so it was ignored` };
}
