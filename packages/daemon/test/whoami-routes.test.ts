import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "../src/db/migrations/002_bindings_sessions.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { snapshotsSchema } from "../src/db/migrations/004_snapshots.js";
import { checkpointsSchema } from "../src/db/migrations/005_checkpoints.js";
import { resumeMetadataSchema } from "../src/db/migrations/006_resume_metadata.js";
import { nodeSpecFieldsSchema } from "../src/db/migrations/007_node_spec_fields.js";
import { agentspecRebootSchema } from "../src/db/migrations/014_agentspec_reboot.js";
import { podNamespaceSchema } from "../src/db/migrations/017_pod_namespace.js";
import { SoftwareTeamRepository } from "../src/domain/software-team-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { TranscriptStore } from "../src/domain/transcript-store.js";
import { WhoamiService } from "../src/domain/whoami-service.js";
import { whoamiRoutes } from "../src/routes/whoami.js";
import { createFullTestDb } from "./helpers/test-app.js";

function setupDb(): Database.Database {
  return createFullTestDb();
}

describe("whoami routes", () => {
  let db: Database.Database;
  let softwareTeamRepo: SoftwareTeamRepository;
  let sessionRegistry: SessionRegistry;

  beforeEach(() => {
    db = setupDb();
    softwareTeamRepo = new SoftwareTeamRepository(db);
    sessionRegistry = new SessionRegistry(db);
  });

  afterEach(() => { db.close(); });

  function createApp(permissionDriftObserver?: { diagnose(nodeId: string): unknown }) {
    const transcriptStore = new TranscriptStore({ transcriptsRoot: "/tmp/transcripts", enabled: true });
    const svc = new WhoamiService({ db, softwareTeamRepo, sessionRegistry, transcriptStore });
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("whoamiService" as never, svc);
      c.set("permissionDriftObserver" as never, permissionDriftObserver);
      await next();
    });
    app.route("/api/whoami", whoamiRoutes());
    return app;
  }

  function seedSoftwareTeam() {
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("my-software-team");
    const node = softwareTeamRepo.addNode(softwareTeam.id, "dev.impl", { role: "worker", runtime: "claude-code" });
    const sess = sessionRegistry.registerSession(node.id, "dev-impl@my-software-team");
    sessionRegistry.updateStatus(sess.id, "running");
    sessionRegistry.updateBinding(node.id, { tmuxSession: "dev-impl@my-software-team" });
    return { softwareTeam, node, sess };
  }

  it("GET /api/whoami?nodeId=... returns 200 with WhoamiResult", async () => {
    const { node } = seedSoftwareTeam();
    const app = createApp();
    const res = await app.request(`/api/whoami?nodeId=${node.id}`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.resolvedBy).toBe("node_id");
    expect(body.identity.logicalId).toBe("dev.impl");
    expect(body.identity.sessionName).toBe("dev-impl@my-software-team");
    expect(body.transcript).toBeDefined();
    expect(body.commands).toBeDefined();
  });

  it("GET /api/whoami?sessionName=... returns 200", async () => {
    seedSoftwareTeam();
    const app = createApp();
    const res = await app.request("/api/whoami?sessionName=dev-impl@my-software-team");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.resolvedBy).toBe("session_name");
    expect(body.identity.logicalId).toBe("dev.impl");
  });

  it("runs the permission observer only for the explicit current-seat diagnostic", async () => {
    const { node } = seedSoftwareTeam();
    const diagnose = vi.fn(() => ({
      transport: { state: "healthy" },
      cwdRead: { state: "visible" },
      commandPath: { state: "available" },
      enforcement: { axis: "permission", state: "drift", expected: "acceptEdits", effective: { defaultMode: "denyAll", allow: [], ask: [], deny: [] }, sourcePath: "/work/.claude/settings.local.json" },
      observedAt: "2026-08-08T00:00:00.000Z",
    }));
    const app = createApp({ diagnose });

    const ordinary = await app.request(`/api/whoami?nodeId=${node.id}`);
    expect(ordinary.status).toBe(200);
    expect((await ordinary.json()).permissionDrift).toBeUndefined();
    expect(diagnose).not.toHaveBeenCalled();

    const diagnostic = await app.request(`/api/whoami?nodeId=${node.id}&diagnostics=permission`);
    expect(diagnostic.status).toBe(200);
    expect((await diagnostic.json()).permissionDrift).toMatchObject({
      enforcement: { state: "drift", sourcePath: "/work/.claude/settings.local.json" },
    });
    expect(diagnose).toHaveBeenCalledOnce();
    expect(diagnose).toHaveBeenCalledWith(node.id);
  });

  it("GET /api/whoami with no params returns 400", async () => {
    seedSoftwareTeam();
    const app = createApp();
    const res = await app.request("/api/whoami");

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("nodeId");
  });

  it("GET /api/whoami?sessionName=unknown returns 404 with guidance", async () => {
    seedSoftwareTeam();
    const app = createApp();
    const res = await app.request("/api/whoami?sessionName=nonexistent-session");

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain("not found");
    expect(body.error).toContain("SoftwareTeam ps");
  });

  it("GET /api/whoami?sessionName=ambiguous returns 409", async () => {
    // Two softwareTeams with same session name
    const rig1 = softwareTeamRepo.createSoftwareTeam("software-team-a");
    const node1 = softwareTeamRepo.addNode(rig1.id, "dev.impl", { role: "worker", runtime: "claude-code" });
    sessionRegistry.registerSession(node1.id, "dev-impl@shared");

    const rig2 = softwareTeamRepo.createSoftwareTeam("software-team-b");
    const node2 = softwareTeamRepo.addNode(rig2.id, "dev.impl", { role: "worker", runtime: "claude-code" });
    sessionRegistry.registerSession(node2.id, "dev-impl@shared");

    const app = createApp();
    const res = await app.request("/api/whoami?sessionName=dev-impl@shared");

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("ambiguous");
  });
});
