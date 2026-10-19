import { DeliveryGuardError } from "../domain/seat-delivery-guard.js";
import { Hono } from "hono";
import type { SoftwareTeamTeardownOrchestrator } from "../domain/software-team-teardown.js";
import type { SoftwareTeamRepository } from "../domain/software-team-repository.js";
import { SoftwareTeamNotFoundError } from "../domain/errors.js";

export const downRoutes = new Hono();

function getDeps(c: { get: (key: string) => unknown }) {
  return {
    teardownOrchestrator: c.get("teardownOrchestrator" as never) as SoftwareTeamTeardownOrchestrator,
  };
}

/**
 * POST /api/down — tear down a softwareTeam.
 * @param softwareTeamId - required softwareTeam identifier
 * @param delete - optional, remove softwareTeam record after stop
 * @param force - optional, kill sessions immediately
 * @param snapshot - optional, snapshot before teardown
 * @returns TeardownResult
 */
downRoutes.post("/", async (c) => {
  const { teardownOrchestrator } = getDeps(c);
  const body: Record<string, unknown> = await c.req.json().catch(() => ({}));
  const softwareTeamId = typeof body["softwareTeamId"] === "string" ? body["softwareTeamId"] : "";
  const deleteSoftwareTeam = body["delete"] === true;
  const force = body["force"] === true;
  const snapshot = body["snapshot"] === true;

  if (!softwareTeamId) {
    return c.json({ error: "softwareTeamId is required" }, 400);
  }

  try {
    const result = await teardownOrchestrator.teardown(softwareTeamId, {
      delete: deleteSoftwareTeam,
      force,
      snapshot,
    });

    // Determine HTTP status
    if (deleteSoftwareTeam && !result.deleted) {
      if (result.deleteBlocked) {
        return c.json(result, 409);
      }
      return c.json(result, 500);
    }

    // Include softwareTeam name + uniqueness in response for post-command handoff
    const softwareTeamRepo = c.get("softwareTeamRepo" as never) as SoftwareTeamRepository;
    const softwareTeam = softwareTeamRepo.getSoftwareTeam(softwareTeamId);
    const softwareTeamName = softwareTeam?.softwareTeam.name ?? null;
    const isUniqueName = softwareTeamName ? softwareTeamRepo.findSoftwareTeamsByName(softwareTeamName).length === 1 : false;
    const enriched = { ...result, softwareTeamName, isUniqueName };
    return c.json(enriched, 200);
  } catch (err) {
    if (err instanceof DeliveryGuardError) throw err;
    if (err instanceof SoftwareTeamNotFoundError) {
      return c.json({ error: err.message }, 404);
    }
    return c.json({ error: (err as Error).message }, 500);
  }
});
