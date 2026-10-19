import type { OperatingPosture } from "../../src/domain/software-team-mode/operating-posture.js";

/** Existing diagnosis mechanics tests deliberately model delegated work.
 * Scope resolution and default/unknown controls use the real reader in operating-posture.test.ts. */
export function delegatedPostureFixture(): OperatingPosture {
  return { posture: "delegated", source: "binding", context: { softwareTeamId: "fixture", phase: { value: "planning", source: "fixture" }, sources: ["fixture"] },
    binding: { id: "software-team:fixture", scope: "softwareTeam", setAt: "2026-09-05T00:00:00Z", evidence: "explicit isolated unit fixture" },
    reason: "Explicit delegated test fixture", grantsAuthority: false };
}
