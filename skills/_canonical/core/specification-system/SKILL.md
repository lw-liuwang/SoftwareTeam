---
name: specification-system
description: Use when authoring SoftwareTeam specs, agent specs, workflow specs, startup/context fragments, operating-mode declarations, or designing the user spec library. Covers the 4 failure modes (spec instantiates topology but not workflow/mode; spec depends on local paths and fails on another host; agents modify specs as one-off files instead of preserving reusable intent; validation proves YAML shape but not whether topology can run) and the validation-vs-runtime-realization distinction.
metadata:
  cli_surfaces_referenced:
    - agent
    - bundle
    - spec
    - specs
  softwareteam:
    stage: factory-approved
    sibling_skills:
      - software-team-lifecycle
      - topology-mutation-and-seat-management
      - seat-scaling-and-specialization
      - cross-host-software-team-commands
      - sidecar-operator
      - software-team-bundles-and-shareable-artifacts
      - extension-and-user-workspace
---

# Specification System

The declarative primitive family for SoftwareTeam intent: **SoftwareTeam specs, agent
specs, workflow specs, startup/context fragments, operating-mode
declarations, and the user spec library that stores and reuses them.**

Specs are how humans and agents describe **repeatable topology and
behavior** without re-explaining it in chat. They are also shareable
artifacts: a user should be able to publish a spec or spec family so
another user can instantiate the same SoftwareTeam shape, role structure, or
workflow pattern.

**Without a dependable spec primitive, SoftwareTeam depends on manual
startup prompts and tribal memory.** That blocks repeatability, product
demos, SoftwareTeam bundles, and autonomous SoftwareTeam construction.

## Use this when

- Authoring a SoftwareTeamSpec / AgentSpec / workflow spec
- Designing a startup/context fragment
- Reasoning about spec-library lifecycle (validation, sharing, upgrade semantics)
- Auditing a spec for portability (does it run on another host?)
- Distinguishing spec vs bundle vs extension cleanly

## Don't use this when

- The work is one-off and won't be reused. Manual SoftwareTeam assembly is fine for one-shot work.
- The intent is to package a topology + workflow as a shareable artifact. That's `software-team-bundles-and-shareable-artifacts`.
- The intent is to add runtime behavior. That's `extension-and-user-workspace`.

## Failure modes (4)

1. **A spec can instantiate a topology but not the workflow or operating mode needed to use it.** Topology is necessary but not sufficient — workflow and operating mode must be declared too.
2. **A shared spec depends on local paths or hidden startup fragments and fails on another host.** Specs must be self-describing for portability.
3. **Agents modify specs as one-off files instead of preserving reusable user/library intent.** Specs are reusable; treating each instance as one-off destroys the primitive's value.
4. **Validation proves YAML shape but not whether the declared topology can actually run.** Structural validation is not enough; runtime realization is the real proof.

## Proof standard

Proof should:

1. Author a spec
2. Validate it (structural)
3. Install it (into spec library)
4. Instantiate it on a **clean SoftwareTeam environment**
5. Show **both structural validation AND runtime realization**

Validation alone is insufficient.

## Spec / bundle / extension boundary

| Concept | Declares | Example |
|---|---|---|
| **Spec** | Topology / role / workflow shape (declarative intent) | `software-team.yaml`, `agent.yaml`, `workflow.yaml` |
| **Bundle** | Spec(s) + supporting fragments packaged for shareable instantiation | A Velocity Team bundle |
| **Extension** | Runtime behavior added to user workspace | SoftwareTeamX command, custom view |

Don't conflate them. The contract should distinguish spec, bundle, and
extension cleanly.

## Currently shipped surfaces

SoftwareTeam already has:

- SoftwareTeamSpec / AgentSpec authoring (`agent.yaml`, `software-team.yaml` formats; see `softwareteam-architect` skill)
- Workflow specs (markdown/YAML files, daemon read-through cache via `workflow_specs` table; see `workflow-runtime` skill)
- Bundle/spec command surface (`SoftwareTeam bundle / spec / agent / specs ls/show/preview/add/sync/remove/rename`)
- Spec library (filesystem-backed at `packages/daemon/specs/` + `~/.softwareteam/specs/` per cli-reference.md)

Not yet shipped:
- Spec library lifecycle (validation, sharing, upgrade) treated as a first-class primitive
- Cross-host spec sharing
- Marketplace / public registry

## See also

- `softwareteam-architect` skill — SoftwareTeamSpec / AgentSpec authoring discipline
- `workflow-runtime` skill — workflow spec authoring + transactional-scribe contract
- `software-team-bundles-and-shareable-artifacts` skill — bundle is the packaged form of specs
- `extension-and-user-workspace` skill — extensions add runtime behavior; specs declare intent
- `softwareteam/docs/reference/software-team-spec.md` (product reference doc) — SoftwareTeamSpec format specification
- `softwareteam/docs/reference/agent-spec.md` (product reference doc) — AgentSpec format specification
