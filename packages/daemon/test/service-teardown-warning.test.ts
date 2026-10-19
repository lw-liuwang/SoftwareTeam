import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { SoftwareTeamRepository } from "../src/domain/software-team-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";
import { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { ComposeServicesAdapter } from "../src/adapters/compose-services-adapter.js";
import { ServiceOrchestrator } from "../src/domain/service-orchestrator.js";
import { SoftwareTeamTeardownOrchestrator } from "../src/domain/software-team-teardown.js";

describe("service teardown receipts", () => {
  let db: Database.Database;
  beforeEach(() => { db = createDb(); migrate(db, ALL_MIGRATIONS); });
  afterEach(() => db.close());

  async function teardown(status: "running" | "exited", failure: boolean) {
    const softwareTeamRepo = new SoftwareTeamRepository(db);
    const sessionRegistry = new SessionRegistry(db);
    const eventBus = new EventBus(db);
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("service-fixture");
    const node = softwareTeamRepo.addNode(softwareTeam.id, "worker");
    const session = sessionRegistry.registerSession(node.id, "worker@service-fixture");
    sessionRegistry.updateStatus(session.id, status);
    softwareTeamRepo.setServicesRecord(softwareTeam.id, { kind: "compose", softwareTeamRoot: "/fixture", composeFile: "compose.yml", specJson: JSON.stringify({ kind: "compose", downPolicy: "down" }), latestReceiptJson: "old-service-receipt" });
    const commands: string[] = [];
    const composeAdapter = new ComposeServicesAdapter(async (command) => {
      commands.push(command);
      if (failure) throw new Error("fixture Docker engine unavailable");
      return "";
    });
    const snapshotCapture = new SnapshotCapture({ db, softwareTeamRepo, sessionRegistry, eventBus,
      snapshotRepo: new SnapshotRepository(db), checkpointStore: new CheckpointStore(db) });
    const orchestrator = new SoftwareTeamTeardownOrchestrator({ db, softwareTeamRepo, sessionRegistry, eventBus, snapshotCapture,
      tmuxAdapter: new TmuxAdapter(async () => ""),
      serviceOrchestrator: new ServiceOrchestrator({ softwareTeamRepo, composeAdapter }) });
    const result = await orchestrator.teardown(softwareTeam.id);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain(" down 2>&1");
    expect(result.alreadyStopped).toBe(status === "exited");
    expect(result.sessionsKilled).toBe(status === "running" ? 1 : 0);
    expect(sessionRegistry.getSessionsForSoftwareTeam(softwareTeam.id).find((entry) => entry.id === session.id)?.status).toBe("exited");
    expect(softwareTeamRepo.getSoftwareTeam(softwareTeam.id)).not.toBeNull();
    return { result, record: softwareTeamRepo.getServicesRecord(softwareTeam.id) };
  }

  it.each(["running", "exited"] as const)("reports a returned Compose failure for a %s softwareTeam", async (status) => {
    const { result, record } = await teardown(status, true);
    expect(result.errors).toEqual(["Service teardown warning: fixture Docker engine unavailable"]);
    expect(record?.latestReceiptJson).toBe("old-service-receipt");
  });

  it.each(["running", "exited"] as const)("keeps successful Compose teardown quiet for a %s softwareTeam", async (status) => {
    const { result, record } = await teardown(status, false);
    expect(result.errors).toEqual([]);
    expect(record?.latestReceiptJson).toBeNull();
  });
});
