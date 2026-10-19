import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { inboxEntriesSchema } from "../src/db/migrations/026_inbox_entries.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { InboxHandler, InboxHandlerError } from "../src/domain/inbox-handler.js";
import type { PersistedEvent } from "../src/domain/types.js";

describe("InboxHandler", () => {
  let db: Database.Database;
  let bus: EventBus;
  let queueRepo: QueueRepository;
  let inbox: InboxHandler;
  let captured: PersistedEvent[];

  beforeEach(() => {
    db = createDb();
    migrate(db, [
      coreSchema,
      eventsSchema,
      queueItemsSchema,
      queueTransitionsSchema,
      inboxEntriesSchema,
    ]);
    bus = new EventBus(db);
    queueRepo = new QueueRepository(db, bus);
    inbox = new InboxHandler(db, bus, queueRepo);
    captured = [];
    bus.subscribe((e) => captured.push(e));
  });

  afterEach(() => db.close());

  it("drop records sender + tags + audit_pointer", () => {
    const e = inbox.drop({
      destinationSession: "bob@software-team",
      senderSession: "alice@software-team",
      body: "async work",
      tags: ["batch", "low-prio"],
      auditPointer: "audit/2026/04/28/x.md",
    });
    expect(e.inboxId).toMatch(/^inbox-\d{14}-[a-f0-9]{8}$/);
    expect(e.senderSession).toBe("alice@software-team");
    expect(e.tags).toEqual(["batch", "low-prio"]);
    expect(e.state).toBe("pending");
    expect(e.auditPointer).toBe("audit/2026/04/28/x.md");
  });

  it("drop is idempotent on inbox_id", () => {
    const id = "inbox-fixed-test-id-0001";
    const a = inbox.drop({
      inboxId: id,
      destinationSession: "bob@software-team",
      senderSession: "alice@software-team",
      body: "first",
    });
    const b = inbox.drop({
      inboxId: id,
      destinationSession: "bob@software-team",
      senderSession: "alice@software-team",
      body: "second-ignored",
    });
    expect(a.inboxId).toBe(b.inboxId);
    expect(b.body).toBe("first");
  });

  // P18 sender-provenance: identity verification moved OUT of the handler to the ONE transport
  // chokepoint. The handler no longer carries an `authenticate` predicate — its allow-all default +
  // body-forwarded principal WERE the fabricated-authority surface. It faithfully records the
  // transport-derived senderSession its caller (the /inbox/drop route) supplies; the forged-sender
  // proof (header-derived vs body-claim + refuse-unattributable) lives at the route.
  it("records exactly the (transport-derived) senderSession it is given", () => {
    const entry = inbox.drop({ destinationSession: "bob@software-team", senderSession: "alice@software-team", body: "x" });
    expect(entry.senderSession).toBe("alice@software-team");
  });

  it("absorb promotes pending entry to a queue_item, emits inbox.absorbed", async () => {
    const entry = inbox.drop({
      destinationSession: "bob@software-team",
      senderSession: "alice@software-team",
      body: "review this",
      urgency: "urgent",
    });
    const result = await inbox.absorb(entry.inboxId, "bob@software-team");
    expect(result.entry.state).toBe("absorbed");
    expect(result.entry.absorbedQitemId).toBe(result.qitemId);

    const qitem = queueRepo.getById(result.qitemId)!;
    expect(qitem.body).toBe("review this");
    expect(qitem.priority).toBe("urgent");
    expect(qitem.sourceSession).toBe("alice@software-team");
    expect(qitem.destinationSession).toBe("bob@software-team");

    expect(captured.some((e) => e.type === "inbox.absorbed")).toBe(true);
  });

  it("absorb is idempotent — second call returns same qitem_id", async () => {
    const entry = inbox.drop({
      destinationSession: "bob@software-team",
      senderSession: "alice@software-team",
      body: "x",
    });
    const a = await inbox.absorb(entry.inboxId, "bob@software-team");
    const b = await inbox.absorb(entry.inboxId, "bob@software-team");
    expect(a.qitemId).toBe(b.qitemId);
  });

  it("absorb refuses if destination doesn't match", async () => {
    const entry = inbox.drop({
      destinationSession: "bob@software-team",
      senderSession: "alice@software-team",
      body: "x",
    });
    await expect(inbox.absorb(entry.inboxId, "carol@software-team")).rejects.toThrow(/destined for/);
  });

  it("deny records reason + emits inbox.denied; cannot subsequently absorb", async () => {
    const entry = inbox.drop({
      destinationSession: "bob@software-team",
      senderSession: "alice@software-team",
      body: "off-topic",
    });
    const denied = inbox.deny(entry.inboxId, "bob@software-team", "off-topic-for-this-software-team");
    expect(denied.state).toBe("denied");
    expect(denied.deniedReason).toBe("off-topic-for-this-software-team");
    expect(captured.some((e) => e.type === "inbox.denied")).toBe(true);
    await expect(inbox.absorb(entry.inboxId, "bob@software-team")).rejects.toThrow(/denied/);
  });

  it("listPending returns only pending entries for the given destination", () => {
    inbox.drop({ destinationSession: "bob@software-team", senderSession: "a@r", body: "1" });
    const e2 = inbox.drop({ destinationSession: "bob@software-team", senderSession: "a@r", body: "2" });
    inbox.drop({ destinationSession: "carol@software-team", senderSession: "a@r", body: "3" });
    inbox.deny(e2.inboxId, "bob@software-team", "no");

    const pending = inbox.listPending("bob@software-team");
    expect(pending).toHaveLength(1);
    expect(pending[0]!.body).toBe("1");
  });
});
