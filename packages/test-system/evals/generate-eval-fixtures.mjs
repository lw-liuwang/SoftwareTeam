#!/usr/bin/env node
/*
 * slice-07 R6 — seed fixture context-library generator.
 *
 * Writes minimal context packs at the canonical refs (skills/<ns>/<name>) the eval cases select among.
 * Derived output (regenerate; never hand-edit under fixtures/). Per Repair 2 the LIVE run does NOT
 * point a seat at these fixtures — it resolves refs against the EXACT production package built by
 * generate-context-packs.mjs. These fixtures back the structural canonical-ref checks only.
 */
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "fixtures");

// ref = library path (ns/name); the pack dir sits at fixtures/<ref>/, served at that ref.
const ENTRIES = [
  { ref: "skills/core/software-team-lifecycle", purpose: "bring softwareTeams and the whole fleet up/down/back", teaches: "For a whole-box bring-back after a reboot, use `SoftwareTeam start` (not per-software-team `SoftwareTeam up`)." },
  { ref: "skills/core/topology-mutation-and-seat-management", purpose: "replace a seat's occupant without losing the address", teaches: "Swap an occupant with `SoftwareTeam handover <seat>` — the seat, name, edges and queue stay put." },
  { ref: "skills/core/agent-startup-and-context-ingestion", purpose: "orient a freshly-woken seat", teaches: "Run `SoftwareTeam whoami --json` first; it is ground truth for who and where you are." },
  { ref: "skills/core/watchdog", purpose: "arm a wake you cannot perform yourself", teaches: "You cannot wake yourself; arm `SoftwareTeam watchdog register --spec <yaml>` before you stop." },
  { ref: "skills/core/cross-host-software-team-commands", purpose: "reach agents on other machines", teaches: "Address a remote seat bare plus `--host <id>` (see `SoftwareTeam host ls`)." },
  { ref: "skills/core/software-team-bundles-and-shareable-artifacts", purpose: "package a SoftwareTeam for a machine that never had the source", teaches: "Build a portable SoftwareTeam with `SoftwareTeam bundle create`; install with `SoftwareTeam bundle install`." },
  { ref: "skills/core/softwareteam-upgrade", purpose: "upgrade a running daemon without downtime", teaches: "Use the sidecar-operator upgrade path so the SoftwareTeam stays up while the daemon upgrades." },
  { ref: "skills/process/systematic-debugging", purpose: "chase a failure methodically", teaches: "Instrument every boundary once and read where it actually breaks — one run beats five hypotheses." },
  { ref: "skills/softwareteam-operating-model", purpose: "place durable knowledge at the right context altitude", teaches: "Put context at the narrowest scope that needs it, and trace one filename toward the root." },
  { ref: "skills/queue-handoff", purpose: "pass active work durably before a turn ends", teaches: "Active work ends by handing off a queue baton, not by going idle at the prompt." },
  // distractors — present so selection is a real choice, not a singleton
  { ref: "skills/core/human-in-the-loop", purpose: "when and how to reach the human", teaches: "Reach the human by exception; orchestrators use discretion, others route through them." },
  { ref: "skills/pm/requirements-writer", purpose: "turn intent into requirements", teaches: "Proportional structured requirements — three capture points, elastic middle." },
  { ref: "skills/process/test-driven-development", purpose: "red-first discipline", teaches: "A failing test per chunk; if you cannot show it red, it is not a check." },
];

rmSync(ROOT, { recursive: true, force: true });
for (const e of ENTRIES) {
  const dir = join(ROOT, e.ref);
  mkdirSync(dir, { recursive: true });
  const name = e.ref.split("/").pop();
  const manifest = `name: ${name}\nversion: "1"\ntaxonomy: skills\npurpose: "(eval fixture) ${e.purpose}"\nfiles:\n  - path: content.md\n    role: source\n`;
  writeFileSync(join(dir, "manifest.yaml"), manifest);
  writeFileSync(join(dir, "content.md"), `# ${e.ref}\n\n${e.purpose}\n\n${e.teaches}\n`);
}
console.log(`wrote ${ENTRIES.length} fixture packs under ${ROOT}`);
