import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { SoftwareTeamRepository } from "../src/domain/software-team-repository.js";
import { PodRepository } from "../src/domain/pod-repository.js";

describe("PodRepository + SoftwareTeamRepository evolution (AS-T08a)", () => {
  let db: Database.Database;
  let softwareTeamRepo: SoftwareTeamRepository;
  let podRepo: PodRepository;

  beforeEach(() => {
    db = createFullTestDb();
    softwareTeamRepo = new SoftwareTeamRepository(db);
    podRepo = new PodRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  // T1: pod record persists and loads correctly
  it("pod record persists and loads correctly", () => {
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("test-software-team");
    const pod = podRepo.createPod(softwareTeam.id, "dev", "Development", {
      summary: "Dev pod",
      continuityPolicyJson: JSON.stringify({ enabled: true, sync_triggers: ["manual"] }),
    });

    expect(pod.id).toBeDefined();
    expect(pod.softwareTeamId).toBe(softwareTeam.id);
    expect(pod.namespace).toBe("dev");
    expect(pod.label).toBe("Development");
    expect(pod.summary).toBe("Dev pod");
    expect(pod.continuityPolicyJson).toContain("enabled");
    expect(pod.createdAt).toBeDefined();

    // Round-trip via getPod
    const loaded = podRepo.getPod(pod.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.namespace).toBe("dev");
    expect(loaded!.label).toBe("Development");
    expect(loaded!.summary).toBe("Dev pod");

    // getPodsForSoftwareTeam
    const pods = podRepo.getPodsForSoftwareTeam(softwareTeam.id);
    expect(pods).toHaveLength(1);
    expect(pods[0]!.id).toBe(pod.id);
  });

  // T2: node creation persists agent_ref, profile, and pod_id
  it("node creation persists agent_ref, profile, and pod_id", () => {
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("test-software-team");
    const pod = podRepo.createPod(softwareTeam.id, "dev", "Dev");

    const node = softwareTeamRepo.addNode(softwareTeam.id, "impl", {
      runtime: "claude-code",
      podId: pod.id,
      agentRef: "local:agents/implementer",
      profile: "tdd",
      label: "Implementer",
    });

    expect(node.podId).toBe(pod.id);
    expect(node.agentRef).toBe("local:agents/implementer");
    expect(node.profile).toBe("tdd");
    expect(node.label).toBe("Implementer");

    // Round-trip via getSoftwareTeam
    const full = softwareTeamRepo.getSoftwareTeam(softwareTeam.id);
    const loadedNode = full!.nodes.find((n) => n.logicalId === "impl");
    expect(loadedNode!.podId).toBe(pod.id);
    expect(loadedNode!.agentRef).toBe("local:agents/implementer");
    expect(loadedNode!.profile).toBe("tdd");
  });

  // T3: resolved spec identity persists on node creation
  it("resolved spec identity persists on node creation", () => {
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("test-software-team");

    const node = softwareTeamRepo.addNode(softwareTeam.id, "impl", {
      runtime: "claude-code",
      resolvedSpecName: "implementer",
      resolvedSpecVersion: "0.2",
      resolvedSpecHash: "sha256:abc123def456",
    });

    expect(node.resolvedSpecName).toBe("implementer");
    expect(node.resolvedSpecVersion).toBe("0.2");
    expect(node.resolvedSpecHash).toBe("sha256:abc123def456");

    // Round-trip
    const full = softwareTeamRepo.getSoftwareTeam(softwareTeam.id);
    const loaded = full!.nodes[0]!;
    expect(loaded.resolvedSpecName).toBe("implementer");
    expect(loaded.resolvedSpecVersion).toBe("0.2");
    expect(loaded.resolvedSpecHash).toBe("sha256:abc123def456");
  });

  // T4: FK behavior between softwareTeam/pod/node matches design
  it("FK behavior: pod with nonexistent SoftwareTeam throws, cross-software-team pod_id throws, same-software-team succeeds", () => {
    // Pod FK on softwareTeam: nonexistent software_team_id throws
    expect(() => podRepo.createPod("nonexistent-software-team", "bad", "Bad")).toThrow();

    // Create two softwareTeams and a pod on softwareTeam A
    const softwareTeamA = softwareTeamRepo.createSoftwareTeam("software-team-a");
    const softwareTeamB = softwareTeamRepo.createSoftwareTeam("software-team-b");
    const podA = podRepo.createPod(softwareTeamA.id, "pod-a", "Pod A");

    // Cross-softwareTeam pod_id: node on softwareTeam B with pod from softwareTeam A -> throws
    expect(() => {
      softwareTeamRepo.addNode(softwareTeamB.id, "impl", { podId: podA.id });
    }).toThrow(/different softwareTeam/);

    // Same-softwareTeam pod_id succeeds
    const node = softwareTeamRepo.addNode(softwareTeamA.id, "impl", { podId: podA.id });
    expect(node.podId).toBe(podA.id);
  });

  // T5: deleting a pod or softwareTeam behaves correctly for member nodes
  it("delete pod -> node.pod_id NULL; delete SoftwareTeam -> cascades pods + nodes", () => {
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("test-software-team");
    const pod = podRepo.createPod(softwareTeam.id, "dev", "Dev");
    const node = softwareTeamRepo.addNode(softwareTeam.id, "impl", { podId: pod.id, runtime: "claude-code" });

    // Delete pod -> node.pod_id becomes NULL
    podRepo.deletePod(pod.id);
    expect(podRepo.getPod(pod.id)).toBeNull();

    const full = softwareTeamRepo.getSoftwareTeam(softwareTeam.id);
    const loadedNode = full!.nodes.find((n) => n.logicalId === "impl");
    expect(loadedNode!.podId).toBeNull();

    // Delete softwareTeam -> cascades pods and nodes
    const pod2 = podRepo.createPod(softwareTeam.id, "arch", "Arch");
    softwareTeamRepo.deleteSoftwareTeam(softwareTeam.id);
    expect(podRepo.getPodsForSoftwareTeam(softwareTeam.id)).toHaveLength(0);
    expect(softwareTeamRepo.getSoftwareTeam(softwareTeam.id)).toBeNull();
  });

  // T6: repository methods use the shared DB handle correctly
  it("repository methods use the shared DB handle", () => {
    expect(softwareTeamRepo.db).toBe(db);
    expect(podRepo.db).toBe(db);
    expect(softwareTeamRepo.db).toBe(podRepo.db);
  });
});
