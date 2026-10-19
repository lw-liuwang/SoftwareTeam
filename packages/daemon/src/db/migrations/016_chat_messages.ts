import type { Migration } from "../migrate.js";

export const chatMessagesSchema: Migration = {
  name: "016_chat_messages.sql",
  sql: `
    CREATE TABLE IF NOT EXISTS chat_messages (
      id          TEXT PRIMARY KEY,
      software_team_id      TEXT NOT NULL REFERENCES software_teams(id) ON DELETE CASCADE,
      sender      TEXT NOT NULL,
      kind        TEXT NOT NULL DEFAULT 'message',
      body        TEXT NOT NULL DEFAULT '',
      topic       TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_chat_messages_software_team_created
      ON chat_messages (software_team_id, created_at);
  `,
};
