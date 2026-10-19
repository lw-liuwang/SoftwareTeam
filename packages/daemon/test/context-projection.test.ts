import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { ContextUsageStore } from "../src/domain/context-usage-store.js";
import { getNodeInventoryWithContext, getNodeDetailWithContext } from "../src/domain/node-inventory.js";

describe("Context Usage Projection", () => {
  let db: Database.Database;
  let setup: ReturnType<typeof createTestApp>;
  let store: ContextUsageStore;

  beforeEach(() => {
    db = createFullTestDb();
    setup = createTestApp(db);
    store = new ContextUsageStore(db, { stateDir: "/tmp/softwareteam-test" });
  });

  afterEach(() => { db.close(); });

  const KNOWN_USAGE = {
    availability: "known" as const,
    reason: null,
    source: "claude_statusline_json" as const,
    usedPercentage: 67,
    remainingPercentage: 33,
    contextWindowSize: 200000,
    totalInputTokens: 120000,
    totalOutputTokens: 14000,
    currentUsage: "67% used",
    transcriptPath: "/tmp/test.log",
    sessionId: "sess-123",
    sessionName: "dev-impl@test-software-team",
    sampledAt: new Date().toISOString(),
    fresh: true,
  };

  // T1: NodeInventoryEntry includes contextUsage for Claude node with persisted data
  it("getNodeInventoryWithContext includes known contextUsage", () => {
    const softwareTeam = setup.softwareTeamRepo.createSoftwareTeam("test-software-team");
    const node = setup.softwareTeamRepo.addNode(softwareTeam.id, "dev.impl", { runtime: "claude-code" });
    setup.sessionRegistry.registerSession(node.id, "dev-impl@test-software-team");
    store.persist(node.id, KNOWN_USAGE);

    const inventory = getNodeInventoryWithContext(db, softwareTeam.id, store);
    const entry = inventory.find((e) => e.logicalId === "dev.impl");

    expect(entry?.contextUsage).toBeDefined();
    expect(entry?.contextUsage?.availability).toBe("known");
    expect(entry?.contextUsage?.usedPercentage).toBe(67);
  });

  // T2: NodeInventoryEntry includes unknown contextUsage for non-Claude node
  it("getNodeInventoryWithContext returns unknown for non-Claude node", () => {
    const softwareTeam = setup.softwareTeamRepo.createSoftwareTeam("test-software-team");
    const node = setup.softwareTeamRepo.addNode(softwareTeam.id, "dev.qa", { runtime: "codex" });
    setup.sessionRegistry.registerSession(node.id, "dev-qa@test-software-team");

    const inventory = getNodeInventoryWithContext(db, softwareTeam.id, store);
    const entry = inventory.find((e) => e.logicalId === "dev.qa");

    expect(entry?.contextUsage?.availability).toBe("unknown");
  });

  // T3: NodeDetailEntry includes full contextUsage
  it("getNodeDetailWithContext includes full contextUsage", () => {
    const softwareTeam = setup.softwareTeamRepo.createSoftwareTeam("test-software-team");
    const node = setup.softwareTeamRepo.addNode(softwareTeam.id, "dev.impl", { runtime: "claude-code" });
    setup.sessionRegistry.registerSession(node.id, "dev-impl@test-software-team");
    store.persist(node.id, KNOWN_USAGE);

    const detail = getNodeDetailWithContext(db, softwareTeam.id, "dev.impl", store);
    expect(detail?.contextUsage?.availability).toBe("known");
    expect(detail?.contextUsage?.usedPercentage).toBe(67);
    expect(detail?.contextUsage?.contextWindowSize).toBe(200000);
  });

  // T4: Graph projection overlay includes compact context data
  it("graph overlay includes compact context data from inventory", async () => {
    const softwareTeam = setup.softwareTeamRepo.createSoftwareTeam("test-software-team");
    const node = setup.softwareTeamRepo.addNode(softwareTeam.id, "dev.impl", { runtime: "claude-code" });
    setup.sessionRegistry.registerSession(node.id, "dev-impl@test-software-team");
    store.persist(node.id, KNOWN_USAGE);

    // Test via HTTP route which uses context-aware inventory
    const res = await setup.app.request(`/api/software-teams/${softwareTeam.id}/graph`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const graphNode = body.nodes.find((n: any) => n.data?.logicalId === "dev.impl");
    expect(graphNode?.data?.contextAvailability).toBe("known");
    expect(graphNode?.data?.contextUsedPercentage).toBe(67);
    expect(graphNode?.data?.contextTotalInputTokens).toBe(120000);
    expect(graphNode?.data?.contextTotalOutputTokens).toBe(14000);
  });

  // T5: WhoamiResult includes contextUsage (via route)
  it("whoami includes contextUsage for Claude node", async () => {
    const softwareTeam = setup.softwareTeamRepo.createSoftwareTeam("test-software-team");
    const node = setup.softwareTeamRepo.addNode(softwareTeam.id, "dev.impl", { runtime: "claude-code" });
    setup.sessionRegistry.registerSession(node.id, "dev-impl@test-software-team");
    store.persist(node.id, KNOWN_USAGE);

    const res = await setup.app.request(`/api/whoami?nodeId=${node.id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.contextUsage).toBeDefined();
    expect(body.contextUsage.availability).toBe("known");
    expect(body.contextUsage.usedPercentage).toBe(67);
  });

  // T6: Unsupported runtime returns unknown honestly
  it("whoami returns unknown contextUsage for codex node", async () => {
    const softwareTeam = setup.softwareTeamRepo.createSoftwareTeam("test-software-team");
    const node = setup.softwareTeamRepo.addNode(softwareTeam.id, "dev.qa", { runtime: "codex" });
    setup.sessionRegistry.registerSession(node.id, "dev-qa@test-software-team");

    const res = await setup.app.request(`/api/whoami?nodeId=${node.id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.contextUsage).toBeDefined();
    expect(body.contextUsage.availability).toBe("unknown");
  });

  // T7: Node detail route returns context data
  it("node detail route includes contextUsage", async () => {
    const softwareTeam = setup.softwareTeamRepo.createSoftwareTeam("test-software-team");
    const node = setup.softwareTeamRepo.addNode(softwareTeam.id, "dev.impl", { runtime: "claude-code" });
    setup.sessionRegistry.registerSession(node.id, "dev-impl@test-software-team");
    store.persist(node.id, KNOWN_USAGE);

    const res = await setup.app.request(`/api/software-teams/${softwareTeam.id}/nodes/${encodeURIComponent("dev.impl")}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.contextUsage).toBeDefined();
    expect(body.contextUsage.availability).toBe("known");
  });
});
