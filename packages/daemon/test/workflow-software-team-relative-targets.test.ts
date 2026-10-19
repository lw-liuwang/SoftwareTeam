import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { WorkflowSpecCache } from "../src/domain/workflow-spec-cache.js";
import { SliceIndexer } from "../src/domain/slices/slice-indexer.js";
import { SliceDetailProjector } from "../src/domain/slices/slice-detail-projector.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { createDaemon } from "../src/startup.js";
import type { CmuxTransportFactory } from "../src/adapters/cmux-transport.js";
import type { ExecFn } from "../src/adapters/tmux.js";
import { expandSoftwareTeamRelativeTarget, isSoftwareTeamRelativeTarget } from "../src/domain/workflow-software-team-placeholder.js";

// A reusable workflow spec can write `member@{softwareTeam}` in preferred_targets;
// `{softwareTeam}` resolves to the instance's bound softwareTeam (--software-team), so one spec
// addresses that softwareTeam's seat, including a terminal member.

const SPEC_SOFTWARE_TEAM_RELATIVE = `workflow:
  id: software-team-relative-targets
  version: 1
  objective: member@{softwareTeam} resolves against the bound softwareTeam
  entry:
    role: watcher
  roles:
    watcher:
      preferred_targets:
        - ops-watcher@{softwareTeam}
    finisher:
      preferred_targets:
        - ops-finisher@{softwareTeam}
  steps:
    - id: watch
      actor_role: watcher
      allowed_exits:
        - handoff
      next_hop:
        mode: require
        suggested_roles:
          - finisher
    - id: finish
      actor_role: finisher
      allowed_exits:
        - done
`;

const SPEC_LITERAL = `workflow:
  id: literal-targets
  version: 1
  objective: literal member@software-team is unchanged
  entry:
    role: watcher
  roles:
    watcher:
      preferred_targets:
        - ops-watcher@software-team-a
  steps:
    - id: watch
      actor_role: watcher
      allowed_exits:
        - done
`;

describe("workflow preferred_targets: member@{softwareTeam}", () => {
  let db: Database.Database;
  let runtime: WorkflowRuntime;
  let tmp: string;
  let relativePath: string;
  let literalPath: string;

  function seedSoftwareTeam(id: string, name: string, member: string, runtimeName: string): void {
    db.prepare(`INSERT INTO software_teams (id, name) VALUES (?, ?)`).run(id, name);
    db.prepare(`INSERT INTO nodes (id, software_team_id, logical_id, runtime) VALUES (?, ?, ?, ?)`)
      .run(`n-${id}`, id, `ops.${member}`, runtimeName);
    db.prepare(`INSERT INTO sessions (id, node_id, session_name, status) VALUES (?, ?, ?, 'running')`)
      .run(`s-${id}`, `n-${id}`, `ops-${member}@${name}`);
  }

  function entryOwner(instanceId: string): string {
    const row = db.prepare(`SELECT destination_session FROM queue_items WHERE qitem_id = (
      SELECT json_extract(current_frontier_json, '$[0]') FROM workflow_instances WHERE instance_id = ?)`)
      .get(instanceId) as { destination_session: string } | undefined;
    expect(row).toBeDefined();
    return row!.destination_session;
  }

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    seedSoftwareTeam("r-a", "software-team-a", "watcher", "claude-code");
    seedSoftwareTeam("r-b", "software-team-b", "watcher", "terminal");
    db.prepare(`INSERT INTO software_teams (id, name) VALUES ('r-orch', 'orch')`).run();
    const bus = new EventBus(db);
    const queueRepo = new QueueRepository(db, bus, { validateSoftwareTeam: () => true });
    queueRepo.attachOutbox(new OutboxHandler(db));
    runtime = new WorkflowRuntime({ db, eventBus: bus, queueRepo });
    tmp = mkdtempSync(join(tmpdir(), "wf-rigrel-"));
    relativePath = join(tmp, "relative.yaml");
    writeFileSync(relativePath, SPEC_SOFTWARE_TEAM_RELATIVE);
    literalPath = join(tmp, "literal.yaml");
    writeFileSync(literalPath, SPEC_LITERAL);
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  const instantiate = (specPath: string, targetSoftwareTeam?: string) =>
    runtime.instantiate({ specPath, rootObjective: "t", createdBySession: "orch@orch", ...(targetSoftwareTeam ? { targetSoftwareTeam } : {}) });

  it("--software-team A resolves ops-watcher@{softwareTeam} to ops-watcher@software-team-a", async () => {
    const r = await instantiate(relativePath, "software-team-a");
    expect(entryOwner(r.instance.instanceId)).toBe("ops-watcher@software-team-a");
  });

  it("--software-team B resolves the same spec to ops-watcher@software-team-b, a terminal member", async () => {
    const r = await instantiate(relativePath, "software-team-b");
    expect(entryOwner(r.instance.instanceId)).toBe("ops-watcher@software-team-b");
  });

  it("literal member@software-team entries behave as before, bound or not", async () => {
    const unbound = await instantiate(literalPath);
    expect(entryOwner(unbound.instance.instanceId)).toBe("ops-watcher@software-team-a");
    const bound = await instantiate(literalPath, "software-team-b");
    expect(entryOwner(bound.instance.instanceId)).toBe("ops-watcher@software-team-a");
  });

  it("later hops use the bound SoftwareTeam too (the stored binding drives every read)", async () => {
    const r = await instantiate(relativePath, "software-team-b");
    db.prepare(`INSERT INTO nodes (id, software_team_id, logical_id, runtime) VALUES ('n-f', 'r-b', 'ops.finisher', 'claude-code')`).run();
    db.prepare(`INSERT INTO sessions (id, node_id, session_name, status) VALUES ('s-f', 'n-f', 'ops-finisher@software-team-b', 'running')`).run();
    const packetId = r.instance.currentFrontier[0] ?? (db.prepare(`SELECT qitem_id FROM queue_items LIMIT 1`).get() as { qitem_id: string }).qitem_id;
    const projected = await runtime.project({
      instanceId: r.instance.instanceId,
      currentPacketId: packetId,
      exit: "handoff",
      actorSession: "ops-watcher@software-team-b",
      resultNote: "next",
    } as never);
    const next = (projected as { nextOwnerSession?: string | null }).nextOwnerSession;
    expect(next).toBe("ops-finisher@software-team-b");
  });

  it("validate on an unbound spec keeps a {softwareTeam} exception target 'unregistered' and says it needs a bound softwareTeam", () => {
    const specPath = join(tmp, "exception.yaml");
    writeFileSync(specPath, SPEC_SOFTWARE_TEAM_RELATIVE + "  exception_routing:\n    orchestrator_role: watcher\n");
    const { exceptionReadiness } = runtime.validate(specPath);
    expect(exceptionReadiness.routes.length).toBeGreaterThan(0);
    for (const route of exceptionReadiness.routes) {
      expect(route.destinationSession).toBe("ops-watcher@{softwareTeam}");
      expect(route.identity).toBe("unregistered");
      expect(route.state).toBe("unregistered");
      expect(route.message).toMatch(/needs a bound softwareTeam \(--software-team\) or a literal SoftwareTeam name/);
    }
  });

  // --- instance reads: each path below reads the spec for a bound instance ---

  const SPEC_FAILABLE = `workflow:
  id: software-team-relative-failable
  version: 1
  objective: a failed step re-resolves a {softwareTeam} target on resume
  entry:
    role: watcher
  roles:
    watcher:
      preferred_targets:
        - ops-watcher@{softwareTeam}
  steps:
    - id: watch
      actor_role: watcher
      allowed_exits:
        - handoff
        - failed
        - done
  exception_routing:
    orchestrator_role: watcher
`;

  function failedInstance(targetSoftwareTeam: string) {
    const specPath = join(tmp, "failable.yaml");
    writeFileSync(specPath, SPEC_FAILABLE);
    return instantiate(specPath, targetSoftwareTeam).then(async (r) => {
      const packetId = r.instance.currentFrontier[0]!;
      await runtime.project({
        instanceId: r.instance.instanceId,
        currentPacketId: packetId,
        exit: "failed",
        actorSession: `ops-watcher@${targetSoftwareTeam}`,
        resultNote: "boom",
      });
      return { instanceId: r.instance.instanceId, packetId };
    });
  }

  it("resume re-resolves the failed step's {softwareTeam} target on the bound softwareTeam", async () => {
    const { instanceId } = await failedInstance("software-team-b");
    const resumed = await runtime.resume({ instanceId, actorSession: "orch@orch" });
    expect(resumed.ownerSession).toBe("ops-watcher@software-team-b");
  });

  it("an unmapped failure's exception item goes to the {softwareTeam} target on the bound softwareTeam", async () => {
    const { instanceId } = await failedInstance("software-team-b");
    const row = db.prepare(`SELECT destination_session FROM queue_items WHERE json_valid(tags)
      AND EXISTS (SELECT 1 FROM json_each(tags) WHERE value = 'workflow-exception')
      AND EXISTS (SELECT 1 FROM json_each(tags) WHERE value = ?)`).get(`instance:${instanceId}`) as { destination_session: string } | undefined;
    expect(row?.destination_session).toBe("ops-watcher@software-team-b");
  });

  it("resolveExceptionRouteFor expands {softwareTeam} with the instance's bound softwareTeam", async () => {
    await failedInstance("software-team-a");
    const route = runtime.resolveExceptionRouteFor("software-team-relative-failable", "1", "unmapped_failed", "software-team-b");
    expect(route?.destinationSession).toBe("ops-watcher@software-team-b");
  });

  it("exceptionReadiness reads the bound instance's target, not the literal {softwareTeam}", async () => {
    const { instanceId } = await failedInstance("software-team-b");
    const readiness = runtime.exceptionReadiness(instanceId)!;
    for (const route of readiness.routes) {
      expect(route.destinationSession).toBe("ops-watcher@software-team-b");
      expect(route.identity).toBe("declared-member");
    }
  });

  it("route re-targets a {softwareTeam} instance's frontier packet", async () => {
    const r = await instantiate(relativePath, "software-team-b");
    const routed = await runtime.route({
      instanceId: r.instance.instanceId, toSession: "other@orch", actorSession: "orch@orch", reason: "move",
    });
    expect(routed.fromSession).toBe("ops-watcher@software-team-b");
    expect(routed.toSession).toBe("other@orch");
  });

  it("abort closes a {softwareTeam} instance and records the step's role", async () => {
    const r = await instantiate(relativePath, "software-team-b");
    const aborted = await runtime.abort({ instanceId: r.instance.instanceId, reason: "stop", actorSession: "orch@orch" });
    expect(aborted.status).toBe("aborted");
    const trail = db.prepare(`SELECT step_role FROM workflow_step_trails WHERE instance_id = ?`).get(r.instance.instanceId) as { step_role: string };
    expect(trail.step_role).toBe("watcher");
  });

  it("the slice view of a bound instance shows the seat the packet went to, not the literal {softwareTeam}", async () => {
    const sliceRoot = join(tmp, "slices");
    mkdirSync(join(sliceRoot, "rr-slice"), { recursive: true });
    writeFileSync(join(sliceRoot, "rr-slice", "README.md"), "---\nslice: rr-slice\nrail-item: PL-test\nstatus: active\n---\n# rr-slice\n");
    const r = await runtime.instantiate({ specPath: relativePath, rootObjective: "rr-slice work", createdBySession: "orch@orch", targetSoftwareTeam: "software-team-b" });
    const indexer = new SliceIndexer({ slicesRoot: sliceRoot, dogfoodEvidenceRoot: null, db });
    const projector = new SliceDetailProjector({ db, indexer, workflowSpecCache: new WorkflowSpecCache(db) });
    const detail = projector.project(indexer.get("rr-slice")!);
    expect(detail.workflowBinding?.instanceId).toBe(r.instance.instanceId);
    expect(detail.topology.specGraph?.nodes.find((n) => n.role === "watcher")?.preferredTarget).toBe("ops-watcher@software-team-b");
  });

  it("an occurrence-local resume (dependency graph) re-resolves the {softwareTeam} target too", async () => {
    const specPath = join(tmp, "graph.yaml");
    writeFileSync(specPath, `workflow:
  id: software-team-relative-graph
  version: 1
  entry: {role: watcher}
  roles:
    watcher:
      preferred_targets:
        - ops-watcher@{softwareTeam}
  exception_routing: {orchestrator_role: watcher}
  steps:
    - id: root
      actor_role: watcher
      depends_on: []
      allowed_exits: [done, failed]
    - id: left
      actor_role: watcher
      depends_on: [root]
      allowed_exits: [done, failed]
    - id: right
      actor_role: watcher
      depends_on: [root]
      allowed_exits: [done, failed]
`);
    const started = await instantiate(specPath, "software-team-b");
    const instanceId = started.instance.instanceId;
    await runtime.project({ instanceId, currentPacketId: started.entryQitemId, actorSession: "ops-watcher@software-team-b", exit: "done" });
    const left = runtime.inspect(instanceId).frontier.find((p) => p.stepId === "left")!.packetId;
    await runtime.project({ instanceId, currentPacketId: left, actorSession: "ops-watcher@software-team-b", exit: "failed", resultNote: "boom" });
    expect(runtime.inspect(instanceId).failures).toHaveLength(1);
    const resumed = await runtime.resume({ instanceId, occurrenceId: left, actorSession: "orch@orch" });
    expect(resumed.ownerSession).toBe("ops-watcher@software-team-b");
  });
});

// The same starts through the daemon's real wiring: startup.ts's software-team-registry
// admission check, not a `validateSoftwareTeam: () => true` fixture, so a literal
// `{softwareTeam}` destination is refused exactly as it is in production.
describe("member@{softwareTeam} through the real admission path", () => {
  let daemon: Awaited<ReturnType<typeof createDaemon>>;
  let tmp: string;

  beforeAll(async () => {
    const cmuxFactory: CmuxTransportFactory = async () => {
      throw Object.assign(new Error(""), { code: "ENOENT" });
    };
    const tmuxExec: ExecFn = async () => "";
    daemon = await createDaemon({ cmuxFactory, tmuxExec });
    for (const name of ["software-team-a", "software-team-b", "prefix-softwareteam-b", "orch"]) daemon.deps.softwareTeamRepo.createSoftwareTeam(name);
    tmp = mkdtempSync(join(tmpdir(), "wf-rigrel-http-"));
  });

  afterAll(() => {
    daemon.db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  const watchStep = `    - id: watch
      actor_role: watcher
      allowed_exits:
        - done
`;
  const withDefault = (yaml: string, defaultSoftwareTeam: string | null) =>
    defaultSoftwareTeam === null ? yaml : yaml.replace("  entry:", `  target:\n    software_team: ${defaultSoftwareTeam}\n  entry:`);
  const specYaml = (id: string, roles: string, steps = watchStep) => `workflow:
  id: ${id}
  version: 1
  objective: member@{softwareTeam} through admission
  entry:
    role: watcher
  roles:
${roles}  steps:
${steps}`;

  let n = 0;
  function writeSpec(yaml: string): string {
    const path = join(tmp, `spec-${++n}.yaml`);
    writeFileSync(path, yaml);
    return path;
  }

  const count = (table: string) => (daemon.db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
  const entryDestination = (instanceId: string) => (daemon.db.prepare(`SELECT destination_session FROM queue_items WHERE qitem_id = (
    SELECT json_extract(current_frontier_json, '$[0]') FROM workflow_instances WHERE instance_id = ?)`)
    .get(instanceId) as { destination_session: string }).destination_session;

  async function start(yaml: string, extra: Record<string, string> = {}) {
    const res = await daemon.app.request("/api/workflow/instantiate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ specPath: writeSpec(yaml), rootObjective: "t", createdBySession: "orch@orch", ...extra }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  }

  // The four shapes whose {softwareTeam} is never the entry target actually used.
  const STARTS: Record<string, { yaml: string; extra?: Record<string, string> }> = {
    "a literal entry with {softwareTeam} only in a later role": {
      yaml: specYaml("start-later-role", `    watcher:
      preferred_targets:
        - ops-watcher@software-team-a
    finisher:
      preferred_targets:
        - ops-finisher@{softwareTeam}
`, `    - id: watch
      actor_role: watcher
      allowed_exits:
        - handoff
      next_hop:
        mode: require
        suggested_roles:
          - finisher
    - id: finish
      actor_role: finisher
      allowed_exits:
        - done
`),
    },
    "a literal entry with {softwareTeam} only in a role that never runs": {
      yaml: specYaml("start-unused-role", `    watcher:
      preferred_targets:
        - ops-watcher@software-team-a
    spare:
      preferred_targets:
        - ops-spare@{softwareTeam}
`),
    },
    "a literal first preferred target with {softwareTeam} second": {
      yaml: specYaml("start-literal-first", `    watcher:
      preferred_targets:
        - ops-watcher@software-team-a
        - ops-watcher@{softwareTeam}
`),
    },
    "a {softwareTeam} role with an explicit entryOwnerSession": {
      yaml: specYaml("start-explicit-owner", `    watcher:
      preferred_targets:
        - ops-watcher@{softwareTeam}
`),
      extra: { entryOwnerSession: "ops-watcher@software-team-a" },
    },
  };

  const UNBOUND: Array<[string, string | null]> = [
    ["no binding", null],
    ["a spec default SoftwareTeam that is not registered", "vanished-software-team"],
  ];

  describe.each(Object.entries(STARTS))("%s", (_name, shape) => {
    it.each(UNBOUND)("still starts with %s: one instance, one entry packet, owner on software-team-a", async (_label, defaultSoftwareTeam) => {
      const instances = count("workflow_instances");
      const packets = count("queue_items");
      const { status, body } = await start(withDefault(shape.yaml, defaultSoftwareTeam), shape.extra);
      expect(status).toBe(201);
      expect(body.instance.boundSoftwareTeam).toBeNull();
      expect(count("workflow_instances")).toBe(instances + 1);
      expect(count("queue_items")).toBe(packets + 1);
      expect(entryDestination(body.instance.instanceId)).toBe("ops-watcher@software-team-a");
    });
  });

  const ENTRY_SOFTWARE_TEAM_RELATIVE = specYaml("start-entry-software-team-relative", `    watcher:
      preferred_targets:
        - ops-watcher@{softwareTeam}
`);

  it("a bound start expands the selected {softwareTeam} entry target", async () => {
    const { status, body } = await start(ENTRY_SOFTWARE_TEAM_RELATIVE, { targetSoftwareTeam: "software-team-b" });
    expect(status).toBe(201);
    expect(body.instance.boundSoftwareTeam).toBe("software-team-b");
    expect(entryDestination(body.instance.instanceId)).toBe("ops-watcher@software-team-b");
  });

  it.each(UNBOUND)("an unbound start whose selected entry target is member@{softwareTeam} is still 400 unknown_destination_software_team with %s, and nothing is created", async (_label, defaultSoftwareTeam) => {
    const instances = count("workflow_instances");
    const packets = count("queue_items");
    const { status, body } = await start(withDefault(ENTRY_SOFTWARE_TEAM_RELATIVE, defaultSoftwareTeam));
    expect(status).toBe(400);
    expect(body.error).toBe("unknown_destination_software_team");
    expect(body.message).toContain("ops-watcher@{softwareTeam}");
    expect(count("workflow_instances")).toBe(instances);
    expect(count("queue_items")).toBe(packets);
  });

  it("an unbound later hop that selects member@{softwareTeam} fails at its own hop, with main's error", async () => {
    const yaml = specYaml("start-later-hop", `    watcher:
      preferred_targets:
        - ops-watcher@software-team-a
    finisher:
      preferred_targets:
        - ops-finisher@{softwareTeam}
`, `    - id: watch
      actor_role: watcher
      allowed_exits:
        - handoff
      next_hop:
        mode: require
        suggested_roles:
          - finisher
    - id: finish
      actor_role: finisher
      allowed_exits:
        - done
`);
    const started = await start(yaml);
    expect(started.status).toBe(201);
    const res = await daemon.app.request("/api/workflow/project", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instanceId: started.body.instance.instanceId,
        currentPacketId: started.body.entryQitemId,
        exit: "handoff",
        actorSession: "ops-watcher@software-team-a",
        resultNote: "next",
      }),
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe("unknown_destination_software_team");
  });

  describe("only a trailing @{softwareTeam} is the form", () => {
    const roles = (target: string) => `    watcher:
      preferred_targets:
        - ${target}
`;

    it("braces in the member part stay literal: ops-{softwareTeam}@software-team-a keeps its destination when bound", async () => {
      const { status, body } = await start(specYaml("start-member-braces", roles("ops-{softwareTeam}@software-team-a")), { targetSoftwareTeam: "software-team-b" });
      expect(status).toBe(201);
      expect(entryDestination(body.instance.instanceId)).toBe("ops-{softwareTeam}@software-team-a");
    });

    // `prefix-softwareteam-b` is registered, so replacing `{softwareTeam}` inside the softwareTeam name would reach it.
    it.each([["bound", { targetSoftwareTeam: "software-team-b" }], ["unbound", {}]])(
      "a partial SoftwareTeam name stays literal and is refused as on main (%s): ops-watcher@prefix-{softwareTeam}",
      async (_label, extra) => {
        const instances = count("workflow_instances");
        const { status, body } = await start(specYaml("start-partial-software-team", roles("ops-watcher@prefix-{softwareTeam}")), extra);
        expect(status).toBe(400);
        expect(body.error).toBe("unknown_destination_software_team");
        expect(count("workflow_instances")).toBe(instances);
      },
    );
  });
});

describe("member@{softwareTeam} helper", () => {
  it("detects and expands only a trailing @{softwareTeam}", () => {
    expect(isSoftwareTeamRelativeTarget("ops-watcher@{softwareTeam}")).toBe(true);
    expect(isSoftwareTeamRelativeTarget("ops-{softwareTeam}@software-team-a")).toBe(false);
    expect(isSoftwareTeamRelativeTarget("ops-watcher@prefix-{softwareTeam}")).toBe(false);
    expect(isSoftwareTeamRelativeTarget("ops-watcher@{softwareTeam}-suffix")).toBe(false);
    expect(expandSoftwareTeamRelativeTarget("ops-watcher@{softwareTeam}", "software-team-b")).toBe("ops-watcher@software-team-b");
    expect(expandSoftwareTeamRelativeTarget("{softwareTeam}@{softwareTeam}", "software-team-b")).toBe("{softwareTeam}@software-team-b");
    expect(expandSoftwareTeamRelativeTarget("ops-{softwareTeam}@software-team-a", "software-team-b")).toBe("ops-{softwareTeam}@software-team-a");
    expect(expandSoftwareTeamRelativeTarget("ops-watcher@prefix-{softwareTeam}", "software-team-b")).toBe("ops-watcher@prefix-{softwareTeam}");
    expect(expandSoftwareTeamRelativeTarget("ops-watcher@{softwareTeam}", null)).toBe("ops-watcher@{softwareTeam}");
  });
});
