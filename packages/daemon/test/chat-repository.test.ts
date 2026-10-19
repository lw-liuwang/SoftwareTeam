import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "../src/db/migrations/002_bindings_sessions.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { chatMessagesSchema } from "../src/db/migrations/016_chat_messages.js";
import { SoftwareTeamRepository } from "../src/domain/software-team-repository.js";
import { HistoryQuery } from "../src/domain/history-query.js";
import { ChatRepository } from "../src/domain/chat-repository.js";

describe("ChatRepository", () => {
  let db: Database.Database;
  let softwareTeamRepo: SoftwareTeamRepository;
  let chatRepo: ChatRepository;
  let softwareTeamId: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, bindingsSessionsSchema, eventsSchema, chatMessagesSchema]);
    softwareTeamRepo = new SoftwareTeamRepository(db);
    chatRepo = new ChatRepository(db);
    const softwareTeam = softwareTeamRepo.createSoftwareTeam("test-software-team");
    softwareTeamId = softwareTeam.id;
  });

  afterEach(() => {
    db.close();
  });

  it.each(["config.json", "function(arg)", "C++", "array[index]"])("history questions find literal chat keyword %s", (keyword) => {
    chatRepo.send(softwareTeamId, "alice", `We discussed ${keyword}`);
    chatRepo.send(softwareTeamId, "bob", "unrelated subject");
    const history = new HistoryQuery({
      transcriptsRoot: "/unused-chat-only-fixture",
      exec: async () => { throw new Error("chat search must not invoke a process"); },
      chatSearchFn: (id, pattern) => chatRepo.searchChat(id, pattern),
    });
    expect(history.searchChat(softwareTeamId, `What about ${keyword}?`).map((row) => row.body)).toEqual([`We discussed ${keyword}`]);
    expect(history.searchChat(softwareTeamId, "What is the")).toEqual([]);
    expect(history.searchChat(softwareTeamId, `unrelated ${keyword}`).length).toBe(2);
  });

  it("same-day ISO since uses UTC chronology including offsets and fractions", () => {
    const early = chatRepo.send(softwareTeamId, "alice", "before cutoff");
    const boundary = chatRepo.send(softwareTeamId, "alice", "at cutoff");
    const late = chatRepo.send(softwareTeamId, "bob", "after cutoff");
    const stamp = db.prepare("UPDATE chat_messages SET created_at = ? WHERE id = ?");
    stamp.run("2026-09-30 10:59:59", early.id);
    stamp.run("2026-09-30 11:00:00", boundary.id);
    stamp.run("2026-09-30 11:00:01", late.id);
    for (const since of ["2026-09-30T11:00:00Z", "2026-09-30 11:00:00", "2026-09-30T07:00:00-04:00"]) {
      expect(chatRepo.history(softwareTeamId, { since }).map(m => m.body)).toEqual(["at cutoff", "after cutoff"]);
    }
    expect(chatRepo.history(softwareTeamId, { since: "2026-09-30T11:00:00.500Z" }).map(m => m.body)).toEqual(["after cutoff"]);
    expect(chatRepo.history(softwareTeamId, { since: "2026-09-30T11:00:00Z", sender: "alice", after: early.id, limit: 1 }).map(m => m.body)).toEqual(["at cutoff"]);
  });

  it("send persists with ULID", () => {
    const msg = chatRepo.send(softwareTeamId, "alice", "hello world");
    expect(msg.id).toBeTruthy();
    expect(msg.id.length).toBe(26); // ULID is 26 chars
    expect(msg.softwareTeamId).toBe(softwareTeamId);
    expect(msg.sender).toBe("alice");
    expect(msg.body).toBe("hello world");
    expect(msg.kind).toBe("message");
    expect(msg.createdAt).toBeTruthy();
  });

  it("history returns chronological order", () => {
    chatRepo.send(softwareTeamId, "alice", "first");
    chatRepo.send(softwareTeamId, "bob", "second");
    chatRepo.send(softwareTeamId, "alice", "third");

    const messages = chatRepo.history(softwareTeamId);
    expect(messages).toHaveLength(3);
    expect(messages[0]!.body).toBe("first");
    expect(messages[1]!.body).toBe("second");
    expect(messages[2]!.body).toBe("third");
  });

  it("history with a limit and no cursor returns the newest messages in chronological order", () => {
    for (let i = 1; i <= 5; i++) chatRepo.send(softwareTeamId, "alice", `msg ${i}`);

    expect(chatRepo.history(softwareTeamId, { limit: 2 }).map((m) => m.body)).toEqual(["msg 4", "msg 5"]);
    expect(chatRepo.history(softwareTeamId, { sender: "alice", limit: 3 }).map((m) => m.body)).toEqual(["msg 3", "msg 4", "msg 5"]);
  });

  it("history with --after pages forward from the cursor", () => {
    const sent = [1, 2, 3, 4, 5].map((i) => chatRepo.send(softwareTeamId, "alice", `msg ${i}`));

    expect(chatRepo.history(softwareTeamId, { after: sent[0]!.id, limit: 2 }).map((m) => m.body)).toEqual(["msg 2", "msg 3"]);
  });

  it("history with --since pages forward from the starting point", () => {
    const sent = [1, 2, 3, 4, 5].map((i) => chatRepo.send(softwareTeamId, "alice", `msg ${i}`));
    const stamp = db.prepare("UPDATE chat_messages SET created_at = ? WHERE id = ?");
    sent.forEach((m, i) => stamp.run(`2026-09-30 11:00:0${i}`, m.id));

    expect(chatRepo.history(softwareTeamId, { since: "2026-09-30T11:00:01Z", limit: 2 }).map((m) => m.body)).toEqual(["msg 2", "msg 3"]);
  });

  it("history --topic returns messages between topic marker and next topic marker", () => {
    chatRepo.send(softwareTeamId, "alice", "before topic");
    chatRepo.sendTopic(softwareTeamId, "alice", "deploy", "starting deploy");
    chatRepo.send(softwareTeamId, "bob", "deploy message");
    chatRepo.send(softwareTeamId, "alice", "another deploy msg");
    chatRepo.sendTopic(softwareTeamId, "bob", "standup", "daily standup");
    chatRepo.send(softwareTeamId, "bob", "standup message — should NOT appear");

    const messages = chatRepo.history(softwareTeamId, { topic: "deploy" });
    const bodies = messages.map((m) => m.body);
    // Should include the deploy topic marker and messages within that topic
    expect(bodies).toContain("starting deploy");
    expect(bodies).toContain("deploy message");
    expect(bodies).toContain("another deploy msg");
    // Should NOT include messages from the next topic
    expect(bodies).not.toContain("daily standup");
    expect(bodies).not.toContain("standup message — should NOT appear");
  });

  it("sendTopic creates topic-kind message", () => {
    const msg = chatRepo.sendTopic(softwareTeamId, "alice", "standup", "daily standup");
    expect(msg.kind).toBe("topic");
    expect(msg.topic).toBe("standup");
    expect(msg.body).toBe("daily standup");
    expect(msg.sender).toBe("alice");
  });

  // Clear tests
  it("clear removes all messages for the target softwareTeam", () => {
    chatRepo.send(softwareTeamId, "alice", "msg1");
    chatRepo.send(softwareTeamId, "bob", "msg2");
    chatRepo.send(softwareTeamId, "alice", "msg3");

    const result = chatRepo.clear(softwareTeamId);
    expect(result.deleted).toBe(3);
    expect(chatRepo.history(softwareTeamId)).toHaveLength(0);
  });

  it("clear returns 0 for empty room", () => {
    const result = chatRepo.clear(softwareTeamId);
    expect(result.deleted).toBe(0);
  });

  it("clear leaves other softwareTeams' messages intact", () => {
    const otherSoftwareTeam = softwareTeamRepo.createSoftwareTeam("other-software-team");
    const otherSoftwareTeamId = otherSoftwareTeam.id;
    chatRepo.send(softwareTeamId, "alice", "target SoftwareTeam msg");
    chatRepo.send(otherSoftwareTeamId, "bob", "other SoftwareTeam msg");

    chatRepo.clear(softwareTeamId);

    expect(chatRepo.history(softwareTeamId)).toHaveLength(0);
    expect(chatRepo.history(otherSoftwareTeamId)).toHaveLength(1);
    expect(chatRepo.history(otherSoftwareTeamId)[0]!.body).toBe("other SoftwareTeam msg");
  });

  // History filter tests
  it("history --sender returns only matching sender", () => {
    chatRepo.send(softwareTeamId, "alice", "alice msg 1");
    chatRepo.send(softwareTeamId, "bob", "bob msg 1");
    chatRepo.send(softwareTeamId, "alice", "alice msg 2");

    const result = chatRepo.history(softwareTeamId, { sender: "alice" });
    expect(result).toHaveLength(2);
    expect(result.every((m) => m.sender === "alice")).toBe(true);
  });

  it("history --since returns only newer messages", () => {
    // Use a past timestamp to ensure messages created "now" are after it
    const pastCutoff = "2020-01-01T00:00:00Z";
    chatRepo.send(softwareTeamId, "alice", "msg after cutoff");
    chatRepo.send(softwareTeamId, "bob", "also after cutoff");

    const result = chatRepo.history(softwareTeamId, { since: pastCutoff });
    expect(result).toHaveLength(2);

    // Use a future timestamp to ensure nothing matches
    const futureCutoff = "2099-01-01T00:00:00Z";
    const futureResult = chatRepo.history(softwareTeamId, { since: futureCutoff });
    expect(futureResult).toHaveLength(0);
  });

  it("combined --sender + --after works", () => {
    const m1 = chatRepo.send(softwareTeamId, "alice", "alice before");
    chatRepo.send(softwareTeamId, "bob", "bob after");
    chatRepo.send(softwareTeamId, "alice", "alice after");

    const result = chatRepo.history(softwareTeamId, { after: m1.id, sender: "alice" });
    expect(result).toHaveLength(1);
    expect(result[0]!.body).toBe("alice after");
  });

  it("--topic + --after composable within topic window", () => {
    chatRepo.sendTopic(softwareTeamId, "host", "review");
    const m1 = chatRepo.send(softwareTeamId, "alice", "first review msg");
    chatRepo.send(softwareTeamId, "bob", "second review msg");

    const result = chatRepo.history(softwareTeamId, { topic: "review", after: m1.id });
    expect(result).toHaveLength(1);
    expect(result[0]!.body).toBe("second review msg");
  });

  it("--topic + --sender composable within topic window", () => {
    chatRepo.send(softwareTeamId, "alice", "before topic");
    chatRepo.sendTopic(softwareTeamId, "host", "review");
    chatRepo.send(softwareTeamId, "alice", "alice review msg");
    chatRepo.send(softwareTeamId, "bob", "bob review msg");

    const result = chatRepo.history(softwareTeamId, { topic: "review", sender: "alice" });
    expect(result).toHaveLength(1);
    expect(result[0]!.body).toBe("alice review msg");
  });
});
