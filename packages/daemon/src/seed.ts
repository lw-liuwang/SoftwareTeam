/**
 * Seed script — creates a sample softwareTeam with nodes and edges for visual QA.
 * Usage: npx tsx packages/daemon/src/seed.ts [dbPath]
 */
import { createDb } from "./db/connection.js";
import { migrate } from "./db/migrate.js";
import { coreSchema } from "./db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "./db/migrations/002_bindings_sessions.js";
import { eventsSchema } from "./db/migrations/003_events.js";
import { SoftwareTeamRepository } from "./domain/software-team-repository.js";
import { SessionRegistry } from "./domain/session-registry.js";

const dbPath = process.argv[2] ?? "softwareteam.sqlite";

console.log(`Seeding database: ${dbPath}`);

const db = createDb(dbPath);
migrate(db, [coreSchema, bindingsSessionsSchema, eventsSchema]);

const repo = new SoftwareTeamRepository(db);

// Create a sample softwareTeam
const softwareTeam = repo.createSoftwareTeam("r99");
console.log(`Created softwareTeam: ${softwareTeam.id} (${softwareTeam.name})`);

// Add nodes — use r99-demo-* names to avoid colliding with real tmux sessions
const orch = repo.addNode(softwareTeam.id, "demo1-lead", { role: "orchestrator", runtime: "claude-code", model: "opus" });
const impl = repo.addNode(softwareTeam.id, "demo1-impl", { role: "worker", runtime: "claude-code", model: "opus" });
const qa = repo.addNode(softwareTeam.id, "demo1-qa", { role: "qa", runtime: "codex", model: "gpt-5.4" });
const reviewer = repo.addNode(softwareTeam.id, "demo1-rev", { role: "reviewer", runtime: "claude-code", model: "opus" });

console.log(`Created nodes: ${orch.logicalId}, ${impl.logicalId}, ${qa.logicalId}, ${reviewer.logicalId}`);

// Add edges
repo.addEdge(softwareTeam.id, orch.id, impl.id, "delegates_to");
repo.addEdge(softwareTeam.id, orch.id, qa.id, "delegates_to");
repo.addEdge(softwareTeam.id, impl.id, qa.id, "can_observe");
repo.addEdge(softwareTeam.id, orch.id, reviewer.id, "delegates_to");

console.log("Created edges: orch->impl, orch->qa, impl->qa, orch->reviewer");

// Add a binding with cmuxSurface to the orchestrator for focus click-through QA
const sessionRegistry = new SessionRegistry(db);
sessionRegistry.updateBinding(orch.id, {
  tmuxSession: "r99-demo1-lead",
  cmuxSurface: "surface-orch-1",
});
console.log("Added cmuxSurface binding to orch1-lead (surface-orch-1)");

db.close();
console.log("Done. Start daemon with: SOFTWARETEAM_DB=" + dbPath + " npx tsx packages/daemon/src/index.ts");
