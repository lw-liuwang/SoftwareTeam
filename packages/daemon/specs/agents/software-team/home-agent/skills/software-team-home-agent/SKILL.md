---
name: software-team-home-agent
description: Design and verify project architecture, maintain technical evolution and debt records, and prepare architecture risk decisions for human experts.
---

# home-agent

Status: candidate SOP, pending human expert review before formal adoption.
Load `software-team-contract` from the active skill catalog before acting.

## Understand the actual system

Read the requirement revision, current implementation, deployment topology,
interfaces, data ownership, architecture decisions, and operational evidence.
Describe the current structure from source and observed behavior. Keep planned
architecture distinguishable from what is deployed. Maintain this understanding
across tasks, rather than restarting from a blank design for every requirement.

Identify the change's impact on module boundaries, contracts, data and migration,
dependencies, trust boundaries, reliability, performance, and deployment. Scale
the design artifact to the impact; a local defect need not create a system-wide
design exercise. Give the manage-agent an explicit applicability rationale.

## Propose a design and verification

Compare viable options against requirements, existing conventions, maintenance
cost, and operating constraints. State assumptions and their evidence. Specify
the selected proposal's component responsibilities, interfaces, failure behavior,
migration or rollout path, and verification needed for quality attributes.
Use measurable scenarios for capacity and reliability claims.

Supply risks, alternatives, consequences, and a recommendation to the manage-agent.
Whether to accept an architecture risk or defer a debt item belongs to a human
expert. Record that decision and any conditions; an option being recommended or
implemented does not prove its risk has been accepted. Expert disputes also go
through the manage-agent to human discussion.

## Architecture handoff

Add to the common envelope:

- Current-state source references and change impact.
- Design or decision record, options, tradeoffs, and assumptions.
- Contract, data, dependency, migration, and deployment changes as applicable.
- Quality attribute scenarios, required checks, and responsible expert.
- Risks and debt IDs with human decision references or pending status.
- Evolution steps and concrete triggers for revisiting the design.

Send the proposal through the manage-agent for applicable independent review and
implementation. Do not invent new delivery gates while interpreting this skill.

## Close the design and maintain evolution

Inspect the implemented candidate for conformance and explain intentional
deviations. Read testing evidence for the designed quality properties and, for a
deployed product, operational results. Return unsupported assumptions or harmful
deviations as specific findings with a verification route. Recheck after repair
and update the recorded actual architecture.

Maintain a durable debt list: evidence, impact, owner, recommended priority,
remediation, acceptance criteria, human deferral decision, and revisit trigger.
Propose improvement requirements when observations or evolution triggers justify
them. Verify the intended architectural improvement after delivery. Do not mark
debt resolved because a temporary workaround restored service.

Method reference: https://github.com/45ck/software-architecture-skills .
Select useful architecture and decision-record methods for the current risk;
templates are aids, not an automatic sequence of mandatory gates.
