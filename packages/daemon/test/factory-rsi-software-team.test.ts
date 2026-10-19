// OPR.0.4.6.FAC2 C2 — the factory-rsi single-softwareTeam RSI factory starter (artifact B).
//
// Proves the softwareTeam spec + its two new agents validate, and — the load-bearing
// cross-check — that every `factory-rsi` workflow role pins 1:1 to a seat
// this softwareTeam declares (no orphan role, no unused seat). VM-only: authored here,
// the deep preflight/scan legs run at the coherent lease.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { SoftwareTeamSpecSchema } from "../src/domain/software-team-spec-schema.js";
import { parseAgentSpec, validateAgentSpec } from "../src/domain/agent-manifest.js";
import { parseWorkflowSpec } from "../src/domain/workflow-spec-cache.js";

const SPECS_ROOT = resolve(import.meta.dirname, "../specs");
const SOFTWARE_TEAM_SPEC = join(SPECS_ROOT, "software-teams/launch/factory-rsi/world-bundle.yaml");
const WORKFLOW_SPEC = resolve(
  import.meta.dirname,
  "../src/builtins/workflow-specs/factory-rsi.yaml",
);
const NEW_AGENTS = [
  "agents/factory-rsi/dogfood/agent.yaml",
  "agents/factory-rsi/release-manager/agent.yaml",
];

interface SoftwareTeamMember {
  id: string;
  agent_ref: string;
  runtime: string;
  profile: string;
  cwd: string;
  model?: string;
}
interface SoftwareTeamPod {
  id: string;
  members: SoftwareTeamMember[];
}

function loadSoftwareTeam(): { name: string; pods: SoftwareTeamPod[] } {
  return parseYaml(readFileSync(SOFTWARE_TEAM_SPEC, "utf-8")) as { name: string; pods: SoftwareTeamPod[] };
}

describe("OPR.0.4.6.FAC2 factory-rsi SoftwareTeam starter", () => {
  it("validates against the software-team-spec schema", () => {
    const raw = parseYaml(readFileSync(SOFTWARE_TEAM_SPEC, "utf-8"));
    const result = SoftwareTeamSpecSchema.validate(raw);
    expect(result.errors).toEqual([]);
  });

  it("declares exactly the seven RSI seats, one member per pod", () => {
    const softwareTeam = loadSoftwareTeam();
    expect(softwareTeam.name).toBe("factory-rsi");
    const seats = softwareTeam.pods.map((p) => {
      expect(p.members).toHaveLength(1);
      return `${p.id}-${p.members[0]!.id}`;
    });
    expect(seats.sort()).toEqual(
      [
        "build-implementer",
        "check-qa",
        "dogfood-tester",
        "orch-lead",
        "plan-planner",
        "release-manager",
        "review-reviewer",
      ].sort(),
    );
  });

  it("per-seat runtime follows the 0.4.6 FAC2 design (builder on claude-code; qa/review/dogfood on the alternate runtime; every seat inherits the runtime default model)", () => {
    // DRIFT VERDICT: STALE ASSERTION (intentional 0.4.6 change), not a
    // regression. The prior assertion pinned "Sonnet Claude seats; Codex
    // builder+checker" with model: sonnet. Release 0.4.6 (commit 8250d702)
    // shipped `specs/software-teams/launch/factory-rsi/world-bundle.yaml` + CULTURE.md with a
    // deliberately different design, documented verbatim in the software-team.yaml
    // summary: "Seats inherit their runtime's default model; qa, review, and
    // dogfood run on the alternate runtime for cross-runtime diversity against
    // the builder." (also CULTURE.md:34 `review-reviewer | codex` and :41).
    // The builder therefore runs claude-code, qa/review/dogfood run codex, and
    // NO seat carries a model pin. This test now tracks the shipped spec.
    const bySeat = new Map<string, SoftwareTeamMember>();
    for (const pod of loadSoftwareTeam().pods) bySeat.set(`${pod.id}-${pod.members[0]!.id}`, pod.members[0]!);

    // The builder + planner/release/orch seats run claude-code.
    for (const seat of ["plan-planner", "build-implementer", "release-manager", "orch-lead"]) {
      expect(bySeat.get(seat)!.runtime).toBe("claude-code");
    }
    // qa, review, and dogfood run on the alternate runtime (codex) for
    // cross-runtime diversity against the builder.
    for (const seat of ["check-qa", "review-reviewer", "dogfood-tester"]) {
      expect(bySeat.get(seat)!.runtime).toBe("codex");
    }
    // Every seat inherits its runtime's default model — no per-seat model pin.
    for (const seat of bySeat.keys()) {
      expect(bySeat.get(seat)!.model).toBeUndefined();
    }
  });

  it("the two new factory-rsi agents validate", () => {
    for (const file of NEW_AGENTS) {
      const raw = parseAgentSpec(readFileSync(join(SPECS_ROOT, file), "utf-8"));
      const result = validateAgentSpec(raw);
      expect(result.valid).toBe(true);
    }
  });

  it("every factory-rsi workflow role pins 1:1 to a factory-rsi seat (no orphan role, no unused seat)", () => {
    const softwareTeam = loadSoftwareTeam();
    const seatRefs = new Set(softwareTeam.pods.map((p) => `${p.id}-${p.members[0]!.id}@factory-rsi`));

    const spec = parseWorkflowSpec(readFileSync(WORKFLOW_SPEC, "utf-8"), WORKFLOW_SPEC);
    const roleTargets = Object.values(spec.roles).map((r) => r.preferred_targets?.[0]);

    // Every role resolves to a declared seat.
    for (const target of roleTargets) {
      expect(target).toBeDefined();
      expect(seatRefs.has(target!)).toBe(true);
    }
    // The mapping is a bijection: 7 roles ↔ 7 seats, each seat used exactly once.
    expect(new Set(roleTargets).size).toBe(seatRefs.size);
    expect(roleTargets.length).toBe(seatRefs.size);
  });
});
