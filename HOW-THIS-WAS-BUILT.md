# How this plugin was built

This note shows the working process behind the code, for readers who want to see how decisions were made and checked. It is a short extract of the development records in the private working repository. Names of people, other projects and machine paths are left out.

## The setup

- One interactive Claude Code session is the main session. It splits work into briefs for subagents, the plugin's own workers, and keeps the records.
- Every decision that changes behaviour, data, a public interface, security or cost goes to a small review team before the owner sees it: Codex (OpenAI's coding agent, in a read-only sandbox, on the ChatGPT plan), Jev (TypeSafe's classifier, which returns probabilities and never sees Claude's pick), and on complex items Fable 5.1 as a read-only subagent, with Gemini 4 Argon as an optional text-only reviewer.
- The rule is that a reviewer's finding is not accepted as given: it is checked against the code or the record before anyone acts on it. The cases below show why that step matters.
- After each piece of work, a reviewer from the other model family reviews the change: Codex reviews what Claude wrote, a Claude reviewer reviews what Codex wrote.

## Record 1: measuring the cost of review, then cutting it (2026-10-04)

By early October the review process had grown: several Claude reviewer agents per change, a second round after the fixes, and now and then a multi-agent review workflow with tens of agents. The question was whether that was proportionate. Instead of guessing, a recount agent went through 181 recorded review rows (179 rows in the tables, plus 2 missed rounds found in the recount, one of them a possible duplicate, with 12 corrections to the rows) and tallied, per reviewer type, the blocking findings recorded as held, the code bugs found, and the Claude tokens spent.

What the tally showed for single Claude reviewers, per 100,000 Claude tokens:

| | Round 1 | Round 2 |
|---|---|---|
| Blocking findings recorded as held | 0.75 (39 over 5.18 million tokens) | 0.22 (4 over 1.82 million) |
| Code bugs | 0.23 (13 over 5.56 million) | 0.24 (5 over 2.09 million) |

The test-quality reviewer fell the most, from 0.97 to 0.10. Seven multi-agent review workflows spent 31 million tokens for 233 confirmed findings of any severity. Where their blocking count is known, in 3 of the 7, it was 3 findings over 11 million tokens. Codex, which uses no Claude tokens, gave about 2 held blocking findings per job.

The record also states what it cannot show: what would have happened without a review, what each reviewer missed (there is no ground truth), whether "held" always means checked (many rows rest only on the word "fixed"), and why round 2 yields less. Round 2 reviews a smaller diff and often resumes with round 1's context, so the drop may come from scope, not from lower value.

The proposal was to trim second rounds to Codex plus the one reviewer whose blocking findings were fixed, and to use multi-agent workflows only for broad audits. Codex reproduced the arithmetic from the raw rows (0.753 against 0.220) and then amended the proposal with two blocking points:

- Do not choose second-round reviewers by the BLOCKING label. One review had zero blocking findings but substantive suggestions, and its follow-up found two code defects. Choose by what the fixes touch.
- Do not overclaim. The records support a cost decision. They do not prove equal defect detection after removing reviewers: the flat code-bug rate matters, and the missing workflow severities are unknown, not zero.

Codex also kept the other-family rule, asked that workflows state an agent count and a token limit before they run, and asked for a sample of the omitted reviews to be checked before a merge. Jev leaned weakly to a prospective trial instead (0.52 against 0.48). The amended rule was adopted and written into the owner's global instructions, with the spot check as the safety net, and it has been in force since.

## Record 2: a wrong evaluation report, caught by the reviewer (2026-10-04)

The same round covered an experiment on one rule of the review skill. Claude's report said that the plain-text graders (regular expressions) matched a manual reading of the generated briefs, and proposed a small regression suite as the next step. Codex read the retained outputs again:

- The regular expression missed four of the five briefs that broke the rule, because they used other words such as "do not investigate" or "don't dig into", and it passed an empty answer. A manual reading gave 10 of 10 compliant briefs with the rule against 0 of 5 without it. The regex gave 4 of 5 false passes in the second group.
- The explanation given for the model judge's failures was unsupported: the saved judge configuration contained the very setting that the explanation said was missing.

Claude's record states, about that experiment: "My first report of B3 was wrong." The next step changed from the regression suite to regrading the retained outputs as a labelled grader test set first, and only then building the suite. The lesson written down: a grader is itself a thing to evaluate, and three agreeing model votes do not make a judgement correct.

## Record 3: a planned feature dropped on the data (2026-10-07)

The next build was going to be a "usage bridge": a way to give the routing hook fresh plan-usage numbers, so that it could move work to Codex when Claude was near its limit. Fable, consulted as a read-only subagent, looked at the dispatch log instead of the design. Only 13 of 597 dispatches had ever seen Claude tight, and the 5-hour window had never passed 45 percent in 61 samples. Fresh samples would rarely change a route. The check held, the bridge was dropped, and the team's pick moved to measuring every subagent's tokens from its transcript inside the log hook, which is what shipped.

## Record 4: an automatic route that was not built (2026-10-03)

The owner asked whether failed Opus tasks should escalate automatically to Fable 5.1. Three designs were weighed: no automatic route, escalation after an Opus failure, and a fixed task class on Fable. Codex and Jev (1.00) picked no automatic route. Codex blocked the escalation design as written: a "blocked" worker usually lacks credentials, permissions or a working environment, which no model fixes, so escalation needs linked attempts, a failure category and a one-retry limit first. The decision records a reopen trigger (repeated task results that show a class where Fable wins) and notes that the trigger is not measured yet. The benchmark premises were recorded with their dates, so the decision can be rechecked when they change.

## What this note leaves out

The private repository holds the full records: the consult briefs and answers word for word, the per-finding verification results, the handoff log, and the raw rows of the tally. This note keeps the shape of each case and the numbers, so that a reader can judge the process without the private material.
