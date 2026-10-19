---
name: software-team-requirements
description: Analyze project requirements into traceable acceptance criteria and accept the tested final candidate against the user's intended outcome.
---

# Requirements Expert

Status: candidate SOP, pending human expert review before formal adoption.
Load `software-team-contract` from the active skill catalog before acting.

## Intake and analysis

Receive the human goal through the coordinator, or an operational improvement
request with incident evidence. Identify users, the problem, current behavior,
desired behavior, scope, exclusions, constraints, and unresolved assumptions.
Inspect the existing product and relevant project records. Distinguish a stated
need from an implementation suggestion and a confirmed fact from an inference.

Write representative user scenarios including failure, empty, permission, and
recovery cases where they affect the outcome. Assign stable requirement and
acceptance criterion IDs. Each criterion states observable behavior, inputs or
preconditions, and what evidence would demonstrate success. Include applicable
quality requirements with measurable bounds; route technical options and design
tradeoffs to architecture rather than silently choosing them.

Send unresolved intent, conflicting requirements, and scope choices to the
coordinator for human discussion. Preserve existing human authorization; do not
invent a new mandatory human sign-off for every requirement unless the approved
project process calls for it.

## Analysis handoff

Add to the common envelope:

- Problem, actors, in-scope and excluded behavior.
- Scenarios and criterion IDs, including quality requirements.
- Assumptions with confirmation status and unresolved decisions.
- Dependencies and an acceptance method for each criterion.
- Requirement revision and change history.

Send the analyzed requirement to the coordinator. Support architecture,
development, and testing questions throughout implementation; update the version
and impact record when the meaning changes. Ensure the coordinator routes those
changes to affected experts. A requirement document alone does not close your work.

## Final acceptance after testing

Accept only an identified candidate for which the testing expert has provided
passing evidence. Read the test coverage and remaining limitations, then inspect
the actual deliverable and exercise the relevant user journeys where available.
Check both criterion fulfillment and the original purpose. Test success does not
prove that a misunderstood requirement meets user intent.

Produce a criterion-to-evidence matrix with pass, fail, or blocked for each item,
the candidate revision, observed behavior, and supporting artifacts. State any
discrepancy between the written requirement and the user's confirmed intent.
Return deficiencies to the coordinator with the affected criterion and whether
clarification, implementation, or new test coverage is needed. Recheck the corrected
candidate after its affected tests pass; preserve the earlier acceptance record.

Requirements acceptance is one expert conclusion. The coordinator decides
progression. For a product it does not replace operations' target deployment and
live retest. For a PR, later requested changes reopen affected acceptance work.

Method reference:
https://github.com/FlameMida/spec-dev/tree/main/skills/requirement-analysis .
Use requirement exploration, scenario analysis, and acceptance methods within
this team's separate architecture and post-test acceptance responsibilities.
