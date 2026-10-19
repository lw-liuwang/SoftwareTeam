import { Hono } from "hono";
import { SoftwareTeamNotFoundError } from "../domain/errors.js";
import type { SnapshotCapture } from "../domain/snapshot-capture.js";
import type { SnapshotRepository } from "../domain/snapshot-repository.js";
import type { RestoreOrchestrator } from "../domain/restore-orchestrator.js";
import type { SessionRegistry } from "../domain/session-registry.js";
import type { ResumeMetadataRefresher } from "../domain/resume-metadata-refresher.js";
import type { SoftwareTeamRepository } from "../domain/software-team-repository.js";
import { deriveRestoreAttemptReceipt } from "../domain/restore-attempt-receipt.js";

export const snapshotsRoutes = new Hono();
export const restoreRoutes = new Hono();

function getDeps(c: { get: (key: string) => unknown }) {
  return {
    snapshotCapture: c.get("snapshotCapture" as never) as SnapshotCapture,
    snapshotRepo: c.get("snapshotRepo" as never) as SnapshotRepository,
    restoreOrchestrator: c.get("restoreOrchestrator" as never) as RestoreOrchestrator,
    // OPR.0.4.3.20 FR-4 — for refresh-before-serialize on manual snapshots.
    resumeMetadataRefresher: c.get("resumeMetadataRefresher" as never) as ResumeMetadataRefresher | undefined,
    sessionRegistry: c.get("sessionRegistry" as never) as SessionRegistry | undefined,
    softwareTeamRepo: c.get("softwareTeamRepo" as never) as SoftwareTeamRepository,
  };
}

// POST /api/software-teams/:softwareTeamId/snapshots
snapshotsRoutes.post("/", async (c) => {
  const softwareTeamId = c.req.param("softwareTeamId")!;
  const body: Record<string, unknown> = await c.req.json().catch(() => ({}));
  const kind = typeof body["kind"] === "string" ? body["kind"] : "manual";
  const { snapshotCapture, resumeMetadataRefresher, sessionRegistry, softwareTeamRepo } = getDeps(c);

  try {
    // OPR.0.4.3.20 FR-4 — refresh live tokens before serialize, in its OWN
    // try/catch so a refresh throw NEVER skips the snapshot (guard caveat).
    if (resumeMetadataRefresher && sessionRegistry) {
      try {
        // fillNullOnly: a routine snapshot refresh fills null tokens (lightweight
        // sidecar/pid-log reads) but NEVER clears a present token nor spawns a
        // `claude --resume` probe (rev1 fix — keep stale-present for FR-6, no
        // recurring probe blast radius).
        await resumeMetadataRefresher.refresh(
          sessionRegistry.getLatestLiveSessions(softwareTeamId),
          { fillNullOnly: true },
        );
      } catch { /* best-effort — the snapshot still writes below */ }
    }
    let intendedNodeIds: string[] | undefined;
    if (body["intendedSeats"] !== undefined) {
      if (!Array.isArray(body["intendedSeats"])) {
        return c.json({ error: "intendedSeats must be a non-empty array of node references" }, 400);
      }
      const rawRequested = body["intendedSeats"] as unknown[];
      if (rawRequested.length === 0 || !rawRequested.every((value) => typeof value === "string" && value.trim().length > 0)) {
        return c.json({ error: "intendedSeats must be a non-empty array of node references" }, 400);
      }
      const requested = rawRequested.map((value) => (value as string).trim());
      const softwareTeam = softwareTeamRepo.getSoftwareTeam(softwareTeamId);
      if (!softwareTeam) throw new SoftwareTeamNotFoundError(softwareTeamId);
      const byRef = new Map(softwareTeam.nodes.flatMap((node) => [[node.id, node.id], [node.logicalId, node.id]]));
      intendedNodeIds = requested.map((ref) => byRef.get(ref)).filter((id): id is string => !!id);
      if (intendedNodeIds.length !== requested.length || new Set(intendedNodeIds).size !== intendedNodeIds.length) {
        return c.json({ error: "Every intendedSeats entry must name a unique node in the target softwareTeam" }, 400);
      }
    }
    const snapshot = snapshotCapture.captureSnapshot(softwareTeamId, kind, { intendedNodeIds });
    return c.json(snapshot, 201);
  } catch (err) {
    if (err instanceof SoftwareTeamNotFoundError) {
      return c.json({ error: err.message }, 404);
    }
    return c.json({ error: "Failed to capture snapshot" }, 500);
  }
});

// GET /api/software-teams/:softwareTeamId/restore/status/:attemptId — derived, read-only receipt.
restoreRoutes.get("/status/:attemptId", (c) => {
  const softwareTeamId = c.req.param("softwareTeamId")!;
  const attemptId = Number(c.req.param("attemptId"));
  if (!Number.isSafeInteger(attemptId) || attemptId < 1) {
    return c.json({ error: "attemptId must be a positive integer", code: "invalid_attempt_id" }, 400);
  }
  const { snapshotRepo } = getDeps(c);
  const receipt = deriveRestoreAttemptReceipt(snapshotRepo.db, softwareTeamId, attemptId);
  if (!receipt.ok) {
    const status = receipt.code === "attempt_not_found" || receipt.code === "attempt_wrong_software_team" ? 404
      : receipt.code === "attempt_incomplete" ? 409
      : 500;
    return c.json({ error: receipt.message, code: receipt.code }, status);
  }
  return c.json(receipt);
});

// GET /api/software-teams/:softwareTeamId/snapshots
snapshotsRoutes.get("/", (c) => {
  const softwareTeamId = c.req.param("softwareTeamId")!;
  const { snapshotRepo } = getDeps(c);
  return c.json(snapshotRepo.listSnapshots(softwareTeamId));
});

// GET /api/software-teams/:softwareTeamId/snapshots/:id
snapshotsRoutes.get("/:id", (c) => {
  const softwareTeamId = c.req.param("softwareTeamId")!;
  const id = c.req.param("id")!;
  const { snapshotRepo } = getDeps(c);

  const snapshot = snapshotRepo.getSnapshot(id);
  if (!snapshot || snapshot.softwareTeamId !== softwareTeamId) {
    return c.json({ error: "Snapshot not found" }, 404);
  }

  return c.json(snapshot);
});

// POST /api/software-teams/:softwareTeamId/restore/:snapshotId
//
// L3: returns `{ ok: true, attemptId, status: "started", softwareTeamId }` AS SOON AS the
// orchestrator has emitted `restore.started`, BEFORE per-node restore work
// completes. The persisted `restore.started` event seq IS the attempt id
// (Decision 1: no separate restore_attempts table). Per-node work continues in
// the background; clients query event log / node inventory to follow progress.
//
// Pre-restore validation failures and other "couldn't even start" errors return
// the original error payloads with appropriate HTTP status codes (404/409/500),
// because in those cases no `restore.started` event was emitted.
restoreRoutes.post("/:snapshotId", async (c) => {
  const softwareTeamId = c.req.param("softwareTeamId")!;
  const snapshotId = c.req.param("snapshotId")!;
  const { snapshotRepo, restoreOrchestrator } = getDeps(c);

  // Cross-softwareTeam guard: verify snapshot belongs to this softwareTeam
  const snapshot = snapshotRepo.getSnapshot(snapshotId);
  if (!snapshot || snapshot.softwareTeamId !== softwareTeamId) {
    return c.json({ error: "Snapshot not found" }, 404);
  }

  const adapters = c.get("runtimeAdapters" as never) as Record<string, import("../domain/runtime-adapter.js").RuntimeAdapter> | undefined;
  const fs = await import("node:fs");

  return new Promise<Response>((resolve) => {
    let resolved = false;

    const restorePromise = restoreOrchestrator.restore(snapshotId, {
      adapters: adapters ?? {},
      fsOps: { exists: (p: string) => fs.existsSync(p) },
      onAttemptStarted: (attemptId) => {
        if (resolved) return;
        resolved = true;
        // Per-node restore work runs in background; client receives attemptId
        // immediately and can poll /api/events or node inventory for progress.
        resolve(c.json({ ok: true, attemptId, status: "started", softwareTeamId }, 202));
      },
    });

    restorePromise
      .then((outcome) => {
        if (resolved) {
          // Background path: response already sent. Per-node failures are in
          // the event log; no need to do anything here.
          return;
        }
        // Pre-restore-started error path: no `restore.started` was emitted, so
        // the route should respond with the original error mapping.
        resolved = true;
        if (!outcome.ok) {
          if (outcome.code === "pre_restore_validation_failed") {
            resolve(c.json({
              error: outcome.message,
              code: outcome.code,
              ...outcome.result,
              remediation: outcome.result.blockers?.map((blocker) => blocker.remediation) ?? [],
            }, 409));
            return;
          }
          const status = outcome.code === "snapshot_not_found" || outcome.code === "software_team_not_found"
            ? 404
            : outcome.code === "snapshot_unusable" || outcome.code === "restore_in_progress" || outcome.code === "software_team_not_stopped"
            ? 409
            : 500;
          resolve(c.json({ error: outcome.message, code: outcome.code }, status));
          return;
        }
        // Defensive: outcome.ok with no onAttemptStarted firing means the
        // orchestrator emitted restore.started but the callback was somehow
        // bypassed. Surface the result anyway with a synthesized attemptId.
        resolve(c.json({ ok: true, attemptId: -1, status: "completed", softwareTeamId, result: outcome.result }, 200));
      })
      .catch((err) => {
        if (resolved) return;
        resolved = true;
        resolve(c.json({
          error: err instanceof Error ? err.message : String(err),
          code: "restore_error",
        }, 500));
      });
  });
});
