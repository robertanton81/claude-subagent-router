# Third-party notices

Some instructions in this plugin adapt ideas and structure from three MIT-licensed projects. The text is rewritten in our own words, with deliberate changes. Because the adaptations are substantial, this file keeps each project's copyright notice and the MIT permission notice.

## Source inventory

| Upstream | Version read | What we adapted | Where | Deliberate differences |
|---|---|---|---|---|
| Matt Pocock, `skills`, https://github.com/mattpocock/skills | commit `d81f3a1` (2026-09-29) | `skills/engineering/code-review/SKILL.md`: separate Standards and Spec axes, the fail-early check of the change, the list of Fowler code smells as judgement calls | `skills/review/SKILL.md` | A third axis, Correctness, run by the other model family when the router can; a cap of 3 smell findings, each with a concrete consequence; two added smells (low cohesion behind a small interface, a fake without a contract test); spec discovery without an issue-tracker setup file |
| Matt Pocock, `skills` | commit `d81f3a1` | `skills/engineering/diagnosing-bugs/SKILL.md`: a failing command before any hypothesis, ranked hypotheses that can be proven wrong, tagged debug logs, "no correct place for a regression test" as a finding | `agents/debugger.md` | Write modes set by the brief; a budget in tool calls; no human checkpoint inside the worker |
| Jesse Vincent, `superpowers`, https://github.com/obra/superpowers | commit `8ca22db` (v6.4.2, 2026-09-25) | `skills/receiving-code-review/SKILL.md`: check feedback before acting, clarify every unclear item first, check real usage before building what a reviewer asks for, no performative agreement | `skills/review/SKILL.md`, section "Acting on the findings" | Each finding is recorded as accepted, rejected or open; no rule against thanks |
| Jesse Vincent, `superpowers` | commit `8ca22db` | `skills/subagent-driven-development/` and `skills/verification-before-completion/`: review from a recorded base, the author's report as unverified claims, evidence before a "done" claim; `skills/systematic-debugging/`: stop after 3 failed fixes | `agents/reviewer.md`, `agents/implementer.md`, `agents/debugger.md`, `skills/delegate/SKILL.md` | No fixed round count beyond the stop after 3 failed fixes; no session-start bootstrap |
| Open GSD, `gsd-core`, https://github.com/open-gsd/gsd-core | commit `f4be7ed` (2026-09-30, 73 commits after the `v1.15.0` tag) | `gsd-core/references/debugger-fix-acceptance.md`: accept a fix only when the old code fails and the new code passes the same test, and the fix does not just delete behaviour | `agents/debugger.md` | No mutation testing; the old-code check uses a test written before the fix, never a revert in the shared working tree |

## Matt Pocock, skills

Copyright (c) 2026 Matt Pocock

## Jesse Vincent, superpowers

Copyright (c) 2025 Jesse Vincent

## Open GSD, gsd-core

Copyright (c) 2026 Open GSD

## The MIT permission notice (identical for all three projects)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
