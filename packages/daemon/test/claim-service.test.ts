import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { getNodeInventory } from "../src/domain/node-inventory.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { SoftwareTeamRepository } from "../src/domain/software-team-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { DiscoveryRepository } from "../src/domain/discovery-repository.js";
import { ClaimService } from "../src/domain/claim-service.js";
import { vi } from "vitest";
import type { TmuxAdapter, TmuxResult } from "../src/adapters/tmux.js";
import { TranscriptStore } from "../src/domain/transcript-store.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";


describe("ClaimService", () => {
  let db: Database.Database;
  let softwareTeamRepo: SoftwareTeamRepository;
  let sessionRegistry: SessionRegistry;
  let eventBus: EventBus;
  let discoveryRepo: DiscoveryRepository;
  let claimService: ClaimService;
  let mockTmux: TmuxAdapter;
  let setSessionOptionSpy: ReturnType<typeof vi.fn>;
  let sendTextSpy: ReturnType<typeof vi.fn>;
  let sendKeysSpy: ReturnType<typeof vi.fn>;
  let startPipePaneSpy: ReturnType<typeof vi.fn>;
  let ensureContextCollectorSpy: ReturnType<typeof vi.fn>;
  let transcriptStore: TranscriptStore;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    softwareTeamRepo = new SoftwareTeamRepository(db);
    sessionRegistry = new SessionRegistry(db);
    eventBus = new EventBus(db);
    discoveryRepo = new DiscoveryRepository(db);
    setSessionOptionSpy = vi.fn(async () => ({ ok: true as const }));
    sendTextSpy = vi.fn(async () => ({ ok: true as const }));
    sendKeysSpy = vi.fn(async () => ({ ok: true as const }));
    startPipePaneSpy = vi.fn(async () => ({ ok: true as const }));
    ensureContextCollectorSpy = vi.fn();
    mockTmux = {
      setSessionOption: setSessionOptionSpy,
      getSessionOption: vi.fn(async () => null),
      sendText: sendTextSpy,
      sendKeys: sendKeysSpy,
      startPipePane: startPipePaneSpy,
    } as unknown as TmuxAdapter;
    transcriptStore = new TranscriptStore({ transcriptsRoot: "/tmp/softwareteam-claim-service-transcripts", enabled: true });
    claimService = new ClaimService({
      db,
      softwareTeamRepo,
      sessionRegistry,
      discoveryRepo,
      eventBus,
      tmuxAdapter: mockTmux,
      transcriptStore,
      claudeContextProvisioner: {
        ensureContextCollector: ensureContextCollectorSpy,
      },
    });
  });

  afterEach(() => { db.close(); });

  function seedDiscovery(opts?: { runtimeHint?: string; tmuxSession?: string; tmuxPane?: string }) {
    return discoveryRepo.upsertDiscoveredSession({
      tmuxSession: opts?.tmuxSession ?? "organic-session",
      tmuxPane: opts?.tmuxPane ?? "%0",
      runtimeHint: (opts?.runtimeHint ?? "claude-code") as any,
      confidence: "high",
      cwd: "/projects/myapp",
    });
  }

  function seedSoftwareTeam() {
    return softwareTeamRepo.createSoftwareTeam("test-software-team");
  }

  // claim() method removed in bind consolidation — claim-specific tests deleted

  it("an unresolved pane on claim applies to the newly registered occupant", async () => {
    const softwareTeam = seedSoftwareTeam();
    softwareTeamRepo.addNode(softwareTeam.id, "orch.lead", { runtime: "claude-code" });
    const discovered = discoveryRepo.upsertDiscoveredSession({ tmuxSession: "orch-lead@host", tmuxPane: "", runtimeHint: "claude-code", confidence: "high" });
    Object.assign(mockTmux, { listPanes: async () => [] });
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      // SQLite keeps its real clock; freeze registration safely after that floor.
      vi.setSystemTime(Date.now() + 60_000);
      const result = await claimService.bind({ discoveredId: discovered.id, softwareTeamId: softwareTeam.id, logicalId: "orch.lead" });
      expect(result.ok).toBe(true);
      expect(getNodeInventory(db, softwareTeam.id)[0]).toMatchObject({
        storedStartupStatus: "ready", startupStatus: "attention_required",
        identityVerdict: { verdict: "pane_missing", reason: "pane_pid_gone" },
      });
    } finally { vi.useRealTimers(); }
  });

  it("bind attaches a discovered session to an existing node", async () => {
    const softwareTeam = seedSoftwareTeam();
    const node = softwareTeamRepo.addNode(softwareTeam.id, "orch.lead", { runtime: "claude-code", cwd: "/projects/myapp" });
    const discovered = seedDiscovery({ tmuxSession: "orch-lead@host" });

    const result = await claimService.bind({ discoveredId: discovered.id, softwareTeamId: softwareTeam.id, logicalId: "orch.lead" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.nodeId).toBe(node.id);
    const binding = sessionRegistry.getBindingForNode(node.id);
    expect(binding?.tmuxSession).toBe("orch-lead@host");

    const sessions = sessionRegistry.getSessionsForSoftwareTeam(softwareTeam.id).filter((s) => s.nodeId === node.id);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.origin).toBe("claimed");

    const updated = discoveryRepo.getDiscoveredSession(discovered.id);
    expect(updated?.status).toBe("claimed");
    expect(updated?.claimedNodeId).toBe(node.id);
  });

  it("bind replaces an existing NULL pane with the discovered live pane", async () => {
    const softwareTeam = seedSoftwareTeam();
    const node = softwareTeamRepo.addNode(softwareTeam.id, "orch.lead", { runtime: "claude-code", cwd: "/projects/myapp" });
    sessionRegistry.updateBinding(node.id, {});
    expect(sessionRegistry.getBindingForNode(node.id)?.tmuxPane).toBeNull();
    const discovered = seedDiscovery({ tmuxSession: "orch-lead@host", tmuxPane: "%discovered" });

    const result = await claimService.bind({ discoveredId: discovered.id, softwareTeamId: softwareTeam.id, logicalId: "orch.lead" });

    expect(result.ok).toBe(true);
    expect(sessionRegistry.getBindingForNode(node.id)?.tmuxPane).toBe("%discovered");
  });

  it("bind rejects runtime mismatch against the target node", async () => {
    const softwareTeam = seedSoftwareTeam();
    softwareTeamRepo.addNode(softwareTeam.id, "orch.lead", { runtime: "codex", cwd: "/projects/myapp" });
    const discovered = seedDiscovery({ runtimeHint: "claude-code" });

    const result = await claimService.bind({ discoveredId: discovered.id, softwareTeamId: softwareTeam.id, logicalId: "orch.lead" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("runtime_mismatch");
  });

  // T15: bind sets tmux metadata on adopted session
  it("bind sets @softwareteam_* tmux metadata on the adopted session", async () => {
    const softwareTeam = seedSoftwareTeam();
    const node = softwareTeamRepo.addNode(softwareTeam.id, "orch.lead", { runtime: "claude-code", cwd: "/projects/myapp" });
    const discovered = seedDiscovery({ tmuxSession: "orch-lead@host" });

    const result = await claimService.bind({ discoveredId: discovered.id, softwareTeamId: softwareTeam.id, logicalId: "orch.lead" });
    expect(result.ok).toBe(true);

    expect(setSessionOptionSpy).toHaveBeenCalledTimes(5);
    const calls = setSessionOptionSpy.mock.calls as [string, string, string][];
    const metaMap = new Map(calls.map((c) => [c[1], c[2]]));
    expect(metaMap.get("@softwareteam_node_id")).toBe(node.id);
    expect(metaMap.get("@softwareteam_session_name")).toBe("orch-lead@host");
    expect(metaMap.get("@softwareteam_software_team_id")).toBe(softwareTeam.id);
    expect(metaMap.get("@softwareteam_software_team_name")).toBe("test-software-team");
    expect(metaMap.get("@softwareteam_logical_id")).toBe("orch.lead");
  });

  // T16: createAndBindToPod sets tmux metadata
  it("createAndBindToPod sets @softwareteam_* tmux metadata on the adopted session", async () => {
    const softwareTeam = seedSoftwareTeam();
    db.prepare("INSERT INTO pods (id, software_team_id, namespace, label) VALUES (?, ?, ?, ?)").run("pod-dev", softwareTeam.id, "dev", "Dev");
    const discovered = seedDiscovery({ tmuxSession: "dev-coder@host" });

    const result = await claimService.createAndBindToPod({
      discoveredId: discovered.id, softwareTeamId: softwareTeam.id,
      podId: "pod-dev", podNamespace: "dev", memberName: "coder",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(setSessionOptionSpy).toHaveBeenCalledTimes(5);
    const calls = setSessionOptionSpy.mock.calls as [string, string, string][];
    const metaMap = new Map(calls.map((c) => [c[1], c[2]]));
    expect(metaMap.get("@softwareteam_node_id")).toBe(result.nodeId);
    expect(metaMap.get("@softwareteam_session_name")).toBe("dev-coder@host");
    expect(metaMap.get("@softwareteam_software_team_id")).toBe(softwareTeam.id);
    expect(metaMap.get("@softwareteam_software_team_name")).toBe("test-software-team");
    expect(metaMap.get("@softwareteam_logical_id")).toBe("dev.coder");
  });

  // T17: bind delivers post-claim identity hint via sendText + sendKeys Enter
  it("bind delivers post-claim identity hint via sendText + sendKeys", async () => {
    const softwareTeam = seedSoftwareTeam();
    const node = softwareTeamRepo.addNode(softwareTeam.id, "adopted-sess", { runtime: "claude-code", cwd: "/tmp" });
    const discovered = seedDiscovery({ tmuxSession: "adopted-sess" });

    await claimService.bind({ discoveredId: discovered.id, softwareTeamId: softwareTeam.id, logicalId: "adopted-sess" });

    expect(sendTextSpy).toHaveBeenCalled();
    const textCall = sendTextSpy.mock.calls[0] as [string, string];
    expect(textCall[0]).toBe("adopted-sess");
    expect(textCall[1]).toContain("test-software-team");
    expect(textCall[1]).toContain("adopted-sess"); // logicalId defaults to tmux session
    expect(textCall[1]).toContain("SoftwareTeam whoami --json");

    // Must also submit with Enter
    expect(sendKeysSpy).toHaveBeenCalled();
    const keysCall = sendKeysSpy.mock.calls[0] as [string, string[]];
    expect(keysCall[0]).toBe("adopted-sess");
    expect(keysCall[1]).toContain("Enter");
  });

  // T18: bind delivers post-claim identity hint
  it("bind delivers post-claim identity hint via sendText + sendKeys", async () => {
    const softwareTeam = seedSoftwareTeam();
    softwareTeamRepo.addNode(softwareTeam.id, "orch.lead", { runtime: "claude-code", cwd: "/projects/myapp" });
    const discovered = seedDiscovery({ tmuxSession: "orch-lead@host" });

    await claimService.bind({ discoveredId: discovered.id, softwareTeamId: softwareTeam.id, logicalId: "orch.lead" });

    expect(sendTextSpy).toHaveBeenCalled();
    const textCall = sendTextSpy.mock.calls[0] as [string, string];
    expect(textCall[0]).toBe("orch-lead@host");
    expect(textCall[1]).toContain("test-software-team");
    expect(textCall[1]).toContain("orch.lead");

    expect(sendKeysSpy).toHaveBeenCalled();
    const keysCall = sendKeysSpy.mock.calls[0] as [string, string[]];
    expect(keysCall[1]).toContain("Enter");
  });

  // T19: createAndBindToPod delivers post-claim identity hint
  it("createAndBindToPod delivers post-claim identity hint via sendText + sendKeys", async () => {
    const softwareTeam = seedSoftwareTeam();
    db.prepare("INSERT INTO pods (id, software_team_id, namespace, label) VALUES (?, ?, ?, ?)").run("pod-dev2", softwareTeam.id, "dev", "Dev");
    const discovered = seedDiscovery({ tmuxSession: "dev-coder2@host" });

    await claimService.createAndBindToPod({
      discoveredId: discovered.id, softwareTeamId: softwareTeam.id,
      podId: "pod-dev2", podNamespace: "dev", memberName: "coder",
    });

    expect(sendTextSpy).toHaveBeenCalled();
    const textCall = sendTextSpy.mock.calls[0] as [string, string];
    expect(textCall[0]).toBe("dev-coder2@host");
    expect(textCall[1]).toContain("dev.coder");

    expect(sendKeysSpy).toHaveBeenCalled();
    const keysCall = sendKeysSpy.mock.calls[0] as [string, string[]];
    expect(keysCall[1]).toContain("Enter");
  });

  // T20: hint text contains required identity fields
  it("hint text contains SoftwareTeam name, logicalId, and whoami reference", async () => {
    const softwareTeam = seedSoftwareTeam();
    softwareTeamRepo.addNode(softwareTeam.id, "custom.id", { runtime: "claude-code", cwd: "/tmp" });
    const discovered = seedDiscovery({ tmuxSession: "my-session" });

    await claimService.bind({ discoveredId: discovered.id, softwareTeamId: softwareTeam.id, logicalId: "custom.id" });

    const textCall = sendTextSpy.mock.calls[0] as [string, string];
    const hint = textCall[1];
    expect(hint).toContain("test-software-team");
    expect(hint).toContain("custom.id");
    expect(hint).toContain("SoftwareTeam whoami --json");
  });

  // T21: hint delivery failure does not fail bind
  it("bind succeeds even if hint delivery fails", async () => {
    const softwareTeam = seedSoftwareTeam();
    softwareTeamRepo.addNode(softwareTeam.id, "organic-session", { runtime: "claude-code", cwd: "/tmp" });
    const discovered = seedDiscovery();

    sendTextSpy.mockImplementation(async () => { throw new Error("tmux not available"); });

    const result = await claimService.bind({ discoveredId: discovered.id, softwareTeamId: softwareTeam.id, logicalId: "organic-session" });
    expect(result.ok).toBe(true);
  });

  it("bind starts transcript capture for an adopted tmux session", async () => {
    const softwareTeam = seedSoftwareTeam();
    softwareTeamRepo.addNode(softwareTeam.id, "orch.lead", { runtime: "claude-code", cwd: "/projects/myapp" });
    const discovered = seedDiscovery({ tmuxSession: "orch-lead@host" });
    vi.spyOn(transcriptStore, "ensureTranscriptDir").mockReturnValue(true);

    const result = await claimService.bind({ discoveredId: discovered.id, softwareTeamId: softwareTeam.id, logicalId: "orch.lead" });

    expect(result.ok).toBe(true);
    // V1 pre-release Item 1: transcript capture path now starts a
    // rotation timer instead of pipe-pane. Confirm via the rotation
    // module's active-count rather than the legacy pipe-pane spy.
    const { getActiveRotationCount, clearAllTranscriptRotationsForTest } =
      await import("../src/domain/transcript-rotation.js");
    expect(getActiveRotationCount()).toBeGreaterThan(0);
    clearAllTranscriptRotationsForTest();
  });

  it("bind provisions Claude context collection for adopted tmux sessions", async () => {
    const softwareTeam = seedSoftwareTeam();
    softwareTeamRepo.addNode(softwareTeam.id, "orch.lead", { runtime: "claude-code", cwd: "/projects/myapp" });
    const discovered = seedDiscovery({ tmuxSession: "orch-lead@host" });

    const result = await claimService.bind({ discoveredId: discovered.id, softwareTeamId: softwareTeam.id, logicalId: "orch.lead" });

    expect(result.ok).toBe(true);
    expect(ensureContextCollectorSpy).toHaveBeenCalledWith({
      cwd: "/projects/myapp",
      tmuxSession: "orch-lead@host",
    });
  });
});
