// The five questions that Jev answers for every dispatch.
// Jev sees only the brief. It does not see which worker the orchestrator asked
// for, so its answer is an independent second opinion.

const KIND = {
  type: "choice",
  instructions:
    "`brief` is a task that a lead software engineer hands to a helper. What kind of work does the helper have to do?",
  criteria: {
    search:
      "Find, read or explain existing code or documentation. The helper reports what it found. It changes no files.",
    mechanical_edit:
      "Apply a change that the brief already specifies exactly, such as a rename, a move, a reformat, a version bump or a given patch. No design choice is left to the helper.",
    implement:
      "Write or change code to add or alter behaviour. The helper must make design choices inside a scope that the brief defines.",
    debug:
      "Find the cause of a failure, an error or wrong behaviour when the cause is not known yet. The task may include the fix.",
    review:
      "Judge existing code or a set of changes and report problems. It changes no files.",
    design:
      "Produce an architecture, a plan or a comparison of options with trade-offs. The output is advice or a document, not code.",
    other: "None of the other options fits."
  }
};

const WRITES_FILES = {
  type: "noul",
  instructions: "Does the helper have to create or change files in the repository to complete `brief`?",
  criteria: {
    true: "The task cannot be completed without creating, editing or deleting at least one file.",
    false: "The helper only reads, searches, runs checks or reports. It changes no files."
  }
};

const SELF_CONTAINED = {
  type: "noul",
  instructions:
    "Could a skilled engineer who has never seen this project complete `brief` with only the text in `brief` and the repository itself?",
  criteria: {
    true: "The brief names the goal, the place in the code and how to check the result. Nothing outside the brief and the repository is needed.",
    false:
      "The brief depends on an earlier conversation, on decisions that it does not state, or on information that is not in the repository."
  }
};

const DIFFICULTY = {
  type: "score",
  instructions: "How hard is `brief` for a competent software engineer?",
  criteria: [
    "One obvious step. No judgment is needed.",
    "A few steps in one or two files. The approach is clear from the brief.",
    "Several files, or the approach is not given and needs judgment.",
    "A change across many parts of the system, or a subtle problem where a wrong approach is likely without deep reasoning."
  ]
};

// Added after a measurement of a search task. A small model given
// a search brief was cheaper partly because it listed nine of ten directories.
// "Difficulty" did not see that: it rated the brief that failed as the easier
// one. What separates the two cases is whether a missing entry makes the answer
// wrong, so that is asked directly.
const NEEDS_EVERY_MATCH = {
  type: "noul",
  instructions:
    "Is `brief` answered correctly only by a complete list, so that leaving out one matching item makes the answer wrong?",
  criteria: {
    true:
      "The brief asks for every file, every place, every case or every item that matches a condition. The answer is a list, and one missing entry makes it wrong.",
    false:
      "The brief asks for an explanation, a judgement, one example, the places that matter most, or a change to the code. Whether the answer names every match is not what makes it right."
  }
};

export const QUESTIONS = Object.freeze({
  kind: KIND,
  writes_files: WRITES_FILES,
  self_contained: SELF_CONTAINED,
  difficulty: DIFFICULTY,
  needs_every_match: NEEDS_EVERY_MATCH
});

export const KINDS = Object.freeze(Object.keys(KIND.criteria));

export function buildRequest(brief, config) {
  return {
    model: config.jevModel,
    state: {
      brief: {
        description: brief.description ?? "",
        task: brief.prompt ?? ""
      }
    },
    questions: QUESTIONS
  };
}
