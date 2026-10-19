// OPR.0.3.3.19 - softwareTeam archive affordance.
//
// THE load-bearing test is AC-8: archive is non-destructive (retains the softwareTeams
// row + topology + snapshots, restore stays reachable) and is explicitly
// contrasted against `down --delete`, which removes the softwareTeams row and makes
// RestoreOrchestrator return `software_team_not_found`. Archive MUST NOT take the delete path.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { SoftwareTeamRepository } from "../src/domain/software-team-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";
import { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { RestoreOrchestrator } from "../src/domain/restore-orchestrator.js";
import { PsProjectionService } from "../src/domain/ps-projection.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import type { CodexResumeAdapter } from "../src/adapters/codex-resume.js";

function mockTmux(): TmuxAdapter {
  return {
    createSession: vi.fn(async () => ({ ok: true as const })),
    killSession: vi.fn(async () => ({ ok: true as const })),
    sendText: vi.fn(async () => ({ ok: true as const })),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
    getPaneCommand: vi.fn(async () => null),
    capturePaneContent: vi.fn(async () => ""),
    listSessions: async () => [],
    listWindows: async () => [],
    listPanes: async () => [],
    hasSession: async () => false,
  } as unknown as TmuxAdapter;
}

function mockResume(): ClaudeResumeAdapter & CodexResumeAdapter {
  return {
    canResume: vi.fn(() => false),
    resume: vi.fn(async () => ({ ok: true as const })),
  } as unknown as ClaudeResumeAdapter & CodexResumeAdapter;
}

describe("SoftwareTeam archive affordance (OPR.0.3.3.19)", () => {
  let db: Database.Database;
  let softwareTeamRepo: SoftwareTeamRepository;
  let sessionRegistry: SessionRegistry;
  let eventBus: EventBus;
  let snapshotRepo: SnapshotRepository;
  let checkpointStore: CheckpointStore;
  let snapshotCapture: SnapshotCapture;

  beforeEach(() => {
    db = createFullTestDb();
    softwareTeamRepo = new SoftwareTeamRepository(db);
    sessionRegistry = new SessionRegistry(db);
    eventBus = new EventBus(db);
    snapshotRepo = new SnapshotRepository(db);
    checkpointStore = new CheckpointStore(db);
    snapshotCapture = new SnapshotCapture({ db, softwareTeamRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore });
  });

  afterEach(() => { db.close(); });

  function createOrchestrator() {
    const tmux = mockTmux();
    const nodeLauncher = new NodeLauncher({ db, softwareTeamRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
    return new RestoreOrchestrator({
      db, softwareTeamRepo, sessionRegistry, eventBus, snapshotRepo, snapshotCapture,
      checkpointStore, nodeLauncher, tmuxAdapter: tmux,
      claudeResume: mockResume(),
      codexResume: mockResume(),
    });
  }

  /** Build a softwareTeam with two nodes + one edge so retention is observable. */
  function seedSoftwareTeamWithTopology(name: string): string {
    const softwareTeam = softwareTeamRepo.createSoftwareTeam(name);
    const a = softwareTeamRepo.addNode(softwareTeam.id, "orchestrator", { role: "orchestrator", runtime: "claude-code" });
    const b = softwareTeamRepo.addNode(softwareTeam.id, "worker", { role: "worker", runtime: "codex" });
    softwareTeamRepo.addEdge(softwareTeam.id, a.id, b.id, "delegates_to");
    return softwareTeam.id;
  }

  function rowCount(table: string, softwareTeamCol: string, softwareTeamId: string): number {
    return (db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${softwareTeamCol} = ?`).get(softwareTeamId) as { c: number }).c;
  }

  it("AC-8 (load-bearing): archive RETAINS row + topology + snapshots and keeps restore reachable; down --delete REMOVES the row and breaks restore (software_team_not_found)", async () => {
    const orch = createOrchestrator();
    const archiveSoftwareTeam = seedSoftwareTeamWithTopology("archive-me");
    const deleteSoftwareTeam = seedSoftwareTeamWithTopology("delete-me");
    const snapA = snapshotCapture.captureSnapshot(archiveSoftwareTeam, "manual");
    const snapB = snapshotCapture.captureSnapshot(deleteSoftwareTeam, "manual");

    // --- ARCHIVE PATH: non-destructive ---
    expect(softwareTeamRepo.archiveSoftwareTeam(archiveSoftwareTeam)).toBe(true);
    // softwareTeams row + topology rows + snapshot all retained on disk.
    expect(softwareTeamRepo.getSoftwareTeam(archiveSoftwareTeam)).not.toBeNull();
    expect(rowCount("software_teams", "id", archiveSoftwareTeam)).toBe(1);
    expect(rowCount("nodes", "software_team_id", archiveSoftwareTeam)).toBe(2);
    expect(rowCount("edges", "software_team_id", archiveSoftwareTeam)).toBe(1);
    expect(rowCount("snapshots", "software_team_id", archiveSoftwareTeam)).toBeGreaterThan(0);
    // restore is REACHABLE - it does NOT return software_team_not_found, because the row exists.
    const restoreArchived = await orch.restore(snapA.id);
    expect(restoreArchived.ok === false && restoreArchived.code === "software_team_not_found").toBe(false);
    // unarchive returns it to the default view; still non-destructive.
    expect(softwareTeamRepo.unarchiveSoftwareTeam(archiveSoftwareTeam)).toBe(true);
    expect(softwareTeamRepo.getSoftwareTeam(archiveSoftwareTeam)).not.toBeNull();

    // --- DELETE PATH (the contrast): destructive ---
    softwareTeamRepo.deleteSoftwareTeam(deleteSoftwareTeam);
    expect(softwareTeamRepo.getSoftwareTeam(deleteSoftwareTeam)).toBeNull();
    expect(rowCount("software_teams", "id", deleteSoftwareTeam)).toBe(0);
    // restore now breaks with software_team_not_found - the row is gone.
    const restoreDeleted = await orch.restore(snapB.id);
    expect(restoreDeleted.ok).toBe(false);
    if (restoreDeleted.ok === false) {
      expect(restoreDeleted.code).toBe("software_team_not_found");
    }
  });

  describe("repository archive methods + filters", () => {
    it("archiveSoftwareTeam/unarchiveSoftwareTeam flip the flag and are idempotent", () => {
      const softwareTeamId = softwareTeamRepo.createSoftwareTeam("r1").id;
      expect(softwareTeamRepo.archiveSoftwareTeam(softwareTeamId)).toBe(true);
      expect(softwareTeamRepo.archiveSoftwareTeam(softwareTeamId)).toBe(false); // already archived
      expect(softwareTeamRepo.unarchiveSoftwareTeam(softwareTeamId)).toBe(true);
      expect(softwareTeamRepo.unarchiveSoftwareTeam(softwareTeamId)).toBe(false); // already active
    });

    it("listSoftwareTeams / getSoftwareTeamSummaries default-exclude archived; includeArchived / archivedOnly opt in", () => {
      const active = softwareTeamRepo.createSoftwareTeam("active").id;
      const archived = softwareTeamRepo.createSoftwareTeam("archived").id;
      softwareTeamRepo.archiveSoftwareTeam(archived);

      // default excludes archived
      expect(softwareTeamRepo.listSoftwareTeams().map((r) => r.id)).toEqual([active]);
      expect(softwareTeamRepo.getSoftwareTeamSummaries().map((s) => s.id)).toEqual([active]);
      // includeArchived returns both
      expect(softwareTeamRepo.listSoftwareTeams({ includeArchived: true }).map((r) => r.id).sort()).toEqual([active, archived].sort());
      // archivedOnly returns only archived
      expect(softwareTeamRepo.listSoftwareTeams({ archivedOnly: true }).map((r) => r.id)).toEqual([archived]);
      const onlyArchived = softwareTeamRepo.getSoftwareTeamSummaries({ archivedOnly: true });
      expect(onlyArchived.map((s) => s.id)).toEqual([archived]);
      expect(onlyArchived[0]!.archivedAt).not.toBeNull();
    });
  });

  describe("ps-projection archive filter", () => {
    it("getEntries default-excludes archived; includeArchived / archivedOnly opt in; carries isArchived", () => {
      const active = softwareTeamRepo.createSoftwareTeam("active").id;
      const archived = softwareTeamRepo.createSoftwareTeam("archived").id;
      softwareTeamRepo.archiveSoftwareTeam(archived);
      const ps = new PsProjectionService({ db });

      expect(ps.getEntries().map((e) => e.softwareTeamId)).toEqual([active]);
      expect(ps.getEntries({ includeArchived: true }).map((e) => e.softwareTeamId).sort()).toEqual([active, archived].sort());
      const only = ps.getEntries({ archivedOnly: true });
      expect(only.map((e) => e.softwareTeamId)).toEqual([archived]);
      expect(only[0]!.isArchived).toBe(true);
      expect(only[0]!.archivedAt).not.toBeNull();
    });
  });

  describe("AC-4 host-scoped (no cross-host leak)", () => {
    it("archive is local to the host that owns the softwareTeams row; a 2nd host node is unaffected and needs no rework", () => {
      // Two independent daemon DBs == two host nodes. V0.4 multi-host nests each
      // softwareTeam set under its own host node; today there is one localhost, but the
      // archive flag lives on the LOCAL softwareTeams row, so it is keyed by host by
      // construction and can never cross the host boundary. We do NOT build any
      // multi-host table/registry here (out of scope) - two repositories suffice
      // to simulate two hosts and prove no cross-host leak.
      const dbHostA = db; // host A (from beforeEach)
      const repoA = softwareTeamRepo;
      const dbHostB = createFullTestDb(); // host B
      const repoB = new SoftwareTeamRepository(dbHostB);
      try {
        const a1 = repoA.createSoftwareTeam("shared-name").id;
        repoA.createSoftwareTeam("a-active");
        const b1 = repoB.createSoftwareTeam("shared-name").id;
        repoB.createSoftwareTeam("b-active");

        // Archive a softwareTeam under host A only.
        expect(repoA.archiveSoftwareTeam(a1)).toBe(true);

        // Host A: default hides it; archivedOnly shows only it.
        expect(repoA.getSoftwareTeamSummaries().some((s) => s.id === a1)).toBe(false);
        expect(repoA.getSoftwareTeamSummaries({ archivedOnly: true }).map((s) => s.id)).toEqual([a1]);

        // Host B is UNAFFECTED: the same-named softwareTeam stays active + visible, and
        // host B has NO archived softwareTeams at all - the flag never crossed hosts.
        expect(repoB.getSoftwareTeamSummaries().some((s) => s.id === b1)).toBe(true);
        expect(repoB.getSoftwareTeamSummaries({ archivedOnly: true })).toEqual([]);

        // Same guarantee at the ps-projection seam (the CLI/UI default read).
        const psA = new PsProjectionService({ db: dbHostA });
        const psB = new PsProjectionService({ db: dbHostB });
        expect(psA.getEntries().some((e) => e.softwareTeamId === a1)).toBe(false);
        expect(psA.getEntries({ archivedOnly: true }).map((e) => e.softwareTeamId)).toEqual([a1]);
        expect(psB.getEntries({ archivedOnly: true })).toEqual([]);
      } finally {
        dbHostB.close();
      }
    });
  });
});
