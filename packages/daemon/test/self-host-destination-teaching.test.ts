// 51-09 increment 4b — destination-host TEACHING refusal (arch ruling c9964404,
// mechanism ii). 3-part destinations ALREADY refuse loudly (BR-1); 4b adds
// ADDITIVE structured teaching to that existing refusal — it does NOT change the
// code, add a gate, or strip in-band.
//
// WIRING PIN (ruling): the proof exercises the PRODUCTION topologyValidateSoftwareTeam
// predicate (startup.ts:324-334), NOT the admit-everything default
// (queue-repository.ts:417). `topologyValidateSoftwareTeam` below is startup.ts:324-334
// VERBATIM, over a real SoftwareTeamRepository — reference-first, no layer-green theater.
import { describe, it, expect, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "../src/db/migrations/002_bindings_sessions.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { queueTargetRepoSchema } from "../src/db/migrations/039_queue_target_repo.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository, QueueRepositoryError } from "../src/domain/queue-repository.js";
import { SoftwareTeamRepository } from "../src/domain/software-team-repository.js";
import { parseSessionName, isHumanSeatSessionRef } from "../src/domain/session-name.js";
import { setSelfHostId } from "../src/domain/hosts/fanout-contract.js";

function setup(): { repo: QueueRepository; db: Database.Database } {
  const db = createDb();
  migrate(db, [coreSchema, bindingsSessionsSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema, queueTargetRepoSchema]);
  const bus = new EventBus(db);
  const softwareTeamRepo = new SoftwareTeamRepository(db);
  softwareTeamRepo.createSoftwareTeam("known-software-team");
  // startup.ts:324-334 topologyValidateSoftwareTeam, verbatim, over the real softwareTeamRepo:
  const topologyValidateSoftwareTeam = (sessionRef: string): boolean => {
    if (isHumanSeatSessionRef(sessionRef)) return true;
    const parsed = parseSessionName(sessionRef);
    if (parsed.kind !== "canonical") return false;
    return softwareTeamRepo.findSoftwareTeamsByName(parsed.softwareTeam).length > 0;
  };
  const repo = new QueueRepository(db, bus, { validateSoftwareTeam: topologyValidateSoftwareTeam });
  return { repo, db };
}

async function refusalFrom(fn: () => Promise<unknown>): Promise<QueueRepositoryError> {
  try {
    await fn();
    throw new Error("expected an unknown_destination_software_team refusal, but the call succeeded");
  } catch (e) {
    if (e instanceof QueueRepositoryError) return e;
    throw e;
  }
}

describe("51-09 incr 4b — destination-host teaching refusal (injected topologyValidateSoftwareTeam)", () => {
  let db: Database.Database | undefined;
  afterEach(() => { db?.close(); db = undefined; setSelfHostId(null); });

  it("RED1: a 3-part destination refuses with unknown_destination_software_team (code UNCHANGED) + ADDITIVE teaching (split echo + --host hint)", async () => {
    const s = setup(); db = s.db;
    const err = await refusalFrom(() => s.repo.create({ sourceSession: "orch@known-software-team", destinationSession: "orch@unknown@vps-b", body: "hi", priority: "routine" }));
    expect(err.code).toBe("unknown_destination_software_team"); // C1: same code
    expect(err.meta).toBeTruthy();
    expect(err.meta!["destinationSplit"]).toEqual({ member: "orch", softwareTeam: "unknown", host: "vps-b" });
    expect(String(err.meta!["hint"])).toContain("--host vps-b");
    expect(String(err.meta!["hint"])).toContain("orch@unknown"); // resend bare
    expect(err.meta!["selfHost"]).toBe(false);
  });

  it("RED2 (C4): a SELF-suffixed destination gets the SAME refusal with the SELF case named — NO auto-strip / route-home", async () => {
    const s = setup(); db = s.db;
    setSelfHostId("host-self");
    const err = await refusalFrom(() => s.repo.create({ sourceSession: "orch@known-software-team", destinationSession: "orch@known-software-team@host-self", body: "hi", priority: "routine" }));
    expect(err.code).toBe("unknown_destination_software_team"); // refused, NOT routed home
    expect(err.meta!["selfHost"]).toBe(true);
    expect(String(err.meta!["hint"])).toMatch(/THIS host/i);
    expect(String(err.meta!["hint"])).toContain("orch@known-software-team"); // resend bare
    expect(err.meta!["destinationSplit"]).toEqual({ member: "orch", softwareTeam: "known-software-team", host: "host-self" });
  });

  it("RED3 (C1 additive): a plain 2-part unknown SoftwareTeam refuses UNCHANGED — no teaching fields", async () => {
    const s = setup(); db = s.db;
    const err = await refusalFrom(() => s.repo.create({ sourceSession: "orch@known-software-team", destinationSession: "orch@nonexistent", body: "hi", priority: "routine" }));
    expect(err.code).toBe("unknown_destination_software_team");
    expect(err.meta).toBeUndefined(); // additive teaching ONLY for '@'-containing softwareTeam tokens
  });

  it("RED4 (C2 one helper): a cross-host HANDOFF verb emits the SAME teaching (all four refusal sites via one helper)", async () => {
    const s = setup(); db = s.db;
    const src = await s.repo.create({ sourceSession: "orch@known-software-team", destinationSession: "seat@known-software-team", body: "hi", priority: "routine" });
    const errHandoff = await refusalFrom(() => s.repo.handoff({ qitemId: src.qitemId, fromSession: "orch@known-software-team", toSession: "seat@unknown@vps-b" }));
    expect(errHandoff.code).toBe("unknown_destination_software_team");
    expect(String(errHandoff.meta?.["hint"])).toContain("--host vps-b");
    const errHac = await refusalFrom(() => s.repo.handoffAndComplete({ qitemId: src.qitemId, fromSession: "orch@known-software-team", toSession: "seat@unknown@vps-b" }));
    expect(errHac.code).toBe("unknown_destination_software_team");
    expect(String(errHac.meta?.["hint"])).toContain("--host vps-b");
  });

  it("RED5 (C5 honest scope): a 2-part SAME-NAME destination still validates + mints — NOT killed at this gate (closes only via --host / incr-3)", async () => {
    const s = setup(); db = s.db;
    // The D10 silent-mint class (member@software-team whose name exists locally but the sender
    // meant a same-named softwareTeam elsewhere) is NOT closed by this teaching gate — only by
    // the out-of-band --host envelope + sender-side stripping. Honest-scope control:
    const item = await s.repo.create({ sourceSession: "orch@known-software-team", destinationSession: "seat@known-software-team", body: "hi", priority: "routine" });
    expect(item.qitemId).toBeTruthy();
  });
});
