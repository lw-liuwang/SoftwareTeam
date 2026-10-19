import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { migrate } from "../src/db/migrate.js";
import { outboxEntriesSchema } from "../src/db/migrations/027_outbox_entries.js";
import { workflowSpecsSchema } from "../src/db/migrations/033_workflow_specs.js";
import { workflowInstancesSchema } from "../src/db/migrations/034_workflow_instances.js";
import { workflowStepTrailsSchema } from "../src/db/migrations/035_workflow_step_trails.js";
import { queueItemSummarySchema } from "../src/db/migrations/044_queue_item_summary.js";
import { queueItemEvidenceRefSchema } from "../src/db/migrations/048_queue_item_evidence_ref.js";
import { workflowInstanceVersionSchema } from "../src/db/migrations/049_workflow_instance_version.js";
import { workflowSpecJsonSchema } from "../src/db/migrations/050_workflow_spec_json.js";
import { workflowResumeSchema } from "../src/db/migrations/051_workflow_resume.js";
import { workflowInstanceBoundRigSchema } from "../src/db/migrations/052_workflow_instance_bound_rig.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { PodRepository } from "../src/domain/pod-repository.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import { WorkflowValidator } from "../src/domain/workflow-validator.js";
import { parseWorkflowSpec } from "../src/domain/workflow-spec-cache.js";

const roles = ["coordinator", "requirements", "architecture", "development", "review", "testing", "operations"];
const specPath = (mode: string) => resolve(import.meta.dirname, `../src/builtins/workflow-specs/software-team-${mode}.yaml`);
const readSpec = (mode: string) => parseWorkflowSpec(readFileSync(specPath(mode), "utf8"), specPath(mode));
interface Cursor { instanceId: string; packetId: string; stepId: string; waitingOn?: string }

// These tests exercise routing and custody. Evidence quality and human authority
// remain specialist/coordinator SOP obligations, not claims about the runtime.
describe("project software team delivery workflows", () => {
  let db: Database.Database;
  let runtime: WorkflowRuntime;
  let queue: QueueRepository;
  let rigs: RigRepository;
  let pods: PodRepository;
  let sequence: number;

  function seedTeam(name: string, selectedRoles = roles): void {
    const rig = rigs.createRig(name);
    const pod = pods.createPod(rig.id, "team", "Software team");
    for (const role of selectedRoles) {
      const node = rigs.addNode(rig.id, `team.${role}`, {
        role, runtime: "codex", cwd: "/tmp", podId: pod.id,
        agentRef: "local:agents/software-team", profile: "default",
      });
      db.prepare("INSERT INTO sessions (id, node_id, session_name, status) VALUES (?, ?, ?, ?)")
        .run(`session-${++sequence}`, node.id, `team-${role}@${name}`, "running");
    }
  }

  async function start(mode: string, rig = "project-a"): Promise<Cursor> {
    const result = await runtime.instantiate({
      specPath: specPath(mode), targetRig: rig,
      createdBySession: `team-coordinator@${rig}`,
      rootObjective: mode === "pr" ? "Deliver a reviewed PR" : "Deliver a live product",
    });
    expect(result.entryOwnerSession).toBe(`team-coordinator@${rig}`);
    return { instanceId: result.instance.instanceId, packetId: result.entryQitemId, stepId: "intake" };
  }

  async function advance(cursor: Cursor, exit: "handoff" | "waiting" | "done" | "failed" = "handoff") {
    const owner = queue.getById(cursor.packetId)!.destinationSession;
    if (exit === "waiting") {
      const decision = await queue.create({
        sourceSession: owner, destinationSession: "human@host", tier: "human-gate",
        body: "Discuss the disputed architecture decision.", summary: "Choose the architecture resolution",
        evidenceRef: "proof/architecture_gate.md", nudge: false,
      });
      cursor.waitingOn = decision.qitemId;
    }
    const result = await runtime.project({
      instanceId: cursor.instanceId, currentPacketId: cursor.packetId,
      actorSession: owner, exit, resultNote: `${cursor.stepId}: ${exit}; candidate candidate-v1`,
      closureEvidence: { evidence_ref: `proof/${cursor.stepId}.md`, candidate: "candidate-v1" },
      ...(exit === "waiting" ? { blockedOn: cursor.waitingOn } : {}),
    });
    if (result.nextQitemId) {
      cursor.packetId = result.nextQitemId;
      cursor.stepId = result.nextStepId!;
    }
    return result;
  }

  async function walkTo(cursor: Cursor, target: string): Promise<string[]> {
    const visited: string[] = [];
    for (let count = 0; cursor.stepId !== target && count < 30; count++) {
      visited.push(cursor.stepId);
      const result = await advance(cursor);
      expect(result.nextQitemId).not.toBeNull();
    }
    expect(cursor.stepId).toBe(target);
    return visited;
  }

  beforeEach(() => {
    db = createFullTestDb();
    migrate(db, [outboxEntriesSchema, queueItemSummarySchema, queueItemEvidenceRefSchema,
      workflowSpecsSchema, workflowInstancesSchema, workflowStepTrailsSchema,
      workflowInstanceVersionSchema, workflowSpecJsonSchema, workflowResumeSchema,
      workflowInstanceBoundRigSchema]);
    const bus = new EventBus(db);
    queue = new QueueRepository(db, bus, { validateRig: () => true });
    queue.attachOutbox(new OutboxHandler(db));
    rigs = new RigRepository(db);
    pods = new PodRepository(db);
    sequence = 0;
    seedTeam("project-a");
    runtime = new WorkflowRuntime({ db, eventBus: bus, queueRepo: queue,
      exceptionDial: { hostDefault: () => null, humanFallbackSeat: "human@host" } });
  });

  afterEach(() => db.close());

  it.each(["pr", "product"])("validates %s without fixed session destinations and returns every expert result to coordination", mode => {
    const spec = readSpec(mode);
    expect(new WorkflowValidator().validate(spec).ok).toBe(true);
    expect(Object.keys(spec.roles)).toEqual(roles);
    expect(Object.values(spec.roles).every(role => role.preferred_targets === undefined)).toBe(true);
    expect(spec.target).toBeUndefined();
    expect(spec.loop_guards?.max_hops).toBe(100);
    for (const step of spec.steps.filter(step => step.actor_role !== "coordinator")) {
      for (const exit of ["handoff", "failed"] as const) {
        const target = spec.steps.find(candidate => candidate.id === step.next_hop?.on?.[exit]);
        expect(target?.actor_role).toBe("coordinator");
      }
    }
  });

  it("delivers a PR after review, executed testing and requirements acceptance without deployment or merge", async () => {
    const cursor = await start("pr");
    const visited = await walkTo(cursor, "delivery");
    expect(visited).toEqual(["intake", "requirements", "requirements_gate", "architecture", "architecture_gate",
      "development", "development_gate", "architecture_verification", "architecture_verification_gate", "review", "review_gate", "testing", "testing_gate", "acceptance", "acceptance_gate"]);
    expect(readSpec("pr").steps.some(step => step.actor_role === "operations" || /merge|deploy/.test(step.id))).toBe(false);
    const result = await advance(cursor, "done");
    expect(result.instance.status).toBe("completed");
    expect(result.nextQitemId).toBeNull();
  });

  it("keeps a product open until operations deploys and retests it and coordination confirms delivery", async () => {
    const cursor = await start("product");
    await walkTo(cursor, "deployment");
    expect(queue.getById(cursor.packetId)?.destinationSession).toBe("team-operations@project-a");
    expect(runtime.instanceStore.getById(cursor.instanceId)?.status).toBe("active");
    const deployed = await advance(cursor);
    expect(deployed.nextStepId).toBe("deployment_gate");
    expect(deployed.nextOwnerSession).toBe("team-coordinator@project-a");
    await advance(cursor);
    expect(cursor.stepId).toBe("delivery");
    expect(runtime.instanceStore.getById(cursor.instanceId)?.status).toBe("active");
    expect((await advance(cursor, "done")).instance.status).toBe("completed");
  });

  it.each(["architecture_verification", "review", "testing", "deployment"])("returns a failed %s to coordination, then repeats development and independent checks", async stage => {
    const cursor = await start(stage === "deployment" ? "product" : "pr");
    await walkTo(cursor, stage);
    const reported = await advance(cursor, "failed");
    expect(reported.nextStepId).toBe(`${stage}_gate`);
    expect(reported.nextOwnerSession).toBe("team-coordinator@project-a");
    const rework = await advance(cursor, "failed");
    expect(rework.nextStepId).toBe("development");
    expect(rework.nextOwnerSession).toBe("team-development@project-a");
    const repeated = await walkTo(cursor, "acceptance");
    expect(repeated).toEqual(["development", "development_gate", "architecture_verification", "architecture_verification_gate", "review", "review_gate", "testing", "testing_gate"]);
  });

  it("routes rejected requirements acceptance through requirements and architecture again", async () => {
    const cursor = await start("pr");
    await walkTo(cursor, "acceptance");
    await advance(cursor, "failed");
    expect(cursor.stepId).toBe("acceptance_gate");
    await advance(cursor, "failed");
    expect(cursor.stepId).toBe("requirements");
    expect(await walkTo(cursor, "development")).toEqual(["requirements", "requirements_gate", "architecture", "architecture_gate"]);
  });

  it("parks a disputed decision for human discussion without advancing", async () => {
    const cursor = await start("pr");
    await walkTo(cursor, "architecture_gate");
    const result = await advance(cursor, "waiting");
    expect(result.instance.status).toBe("waiting");
    expect(result.nextQitemId).toBeNull();
    expect(queue.getById(cursor.packetId)?.blockedOn).toBe(cursor.waitingOn);
    expect(queue.getById(cursor.waitingOn!)?.destinationSession).toBe("human@host");
  });

  it("binds the same workflow to another project's seven role seats", async () => {
    seedTeam("project-b");
    const cursor = await start("pr", "project-b");
    const next = await advance(cursor);
    expect(next.nextOwnerSession).toBe("team-requirements@project-b");
    expect(next.instance.boundRig).toBe("project-b");
  });

  it("refuses to start when the bound project team lacks a required role", async () => {
    seedTeam("incomplete", roles.filter(role => role !== "testing"));
    await expect(start("pr", "incomplete")).rejects.toMatchObject({ code: "bound_rig_role_uncovered" });
    expect(runtime.instanceStore.listAll()).toEqual([]);
  });
});
