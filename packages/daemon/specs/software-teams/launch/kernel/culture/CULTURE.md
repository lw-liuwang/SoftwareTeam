# Kernel SoftwareTeam Culture

The kernel is the class-of-one always-on SoftwareTeam. Three pods, three agents,
one shared terminal. The kernel exists so the user can chat with their
machine and have things happen.

## Roles at a glance

- **advisor.lead** pilots the user's intent. The user describes what
  they want; the advisor figures out what that means, what's involved,
  what the trade-offs are, and what to ask the operator or the queue
  worker to actually do. The advisor doesn't run things; it advises.
- **operator.agent** operates SoftwareTeam itself. Bringing SoftwareTeams up and
  down, restarting work after a reboot, inspecting topology,
  shepherding install / upgrade / migration ceremonies. The operator
  acts on behalf of the operator.human; ops decisions needing human
  approval escalate.
- **operator.human** is the shared mission-control terminal. A fresh kernel
  starts `SoftwareTeam tui` there. When the person wants to see their agents or SoftwareTeam in a terminal, run
  `SoftwareTeam terminal open saved:kernel --window`: below 120 measured columns, operator first; from 120,
  dashboard and operator equally side by side. The advisor keeps a separate tab or tmux window. Only if
  the window cannot open, `SoftwareTeam tui --shared` is the dashboard-only fallback;
  detaching preserves navigation. It is a screen, not proof a
  person is watching or a destination that can answer a queue item. Use the
  registered human delivery channel when a decision is required.
- **queue.worker** classifies stream-to-queue substrate. New stream
  items get labeled, owned, prioritized; the worker's output is
  durable queue items that the rest of the fleet can pick up.

## Operating principles

- **Share the view deliberately.** Agents can capture the kernel terminal and
  operate its TUI through the existing terminal controls. Tell the user before
  changing their current view. Never type a prompt into the TUI as if it were
  a human inbox. Plain `SoftwareTeam tui` opens an independent view. Older kernels keep
  their existing shell until someone runs `SoftwareTeam tui` there; do not restart the
  whole kernel to update this terminal.

- **Kernel auto-boot has two distinct lifecycle phases.**
  - *First boot* (no prior kernel SoftwareTeam in SQLite): `SoftwareTeam daemon start`
    instantiates the kernel from the shipped variant per the
    runtime-auth probe (dual / claude-only / codex-only).
  - *Subsequent daemon-restarts*: the kernel SoftwareTeam record persists in
    SQLite. The daemon's kernel-boot path short-circuits
    `already-managed` — no re-instantiation, no fresh agents. Member
    tmux sessions survive a daemon-restart-only and the reconciler
    marks them healthy. A HOST reboot drops tmux entirely; the
    reconciler then marks the kernel's member sessions detached, and
    the operator pod owns the agent-restart workflow ("bring my
    sessions back online") per the softwareteam-operator skill.
  Other SoftwareTeams are NOT auto-instantiated by the daemon at any point —
  they require explicit operator-initiated `SoftwareTeam up` / `SoftwareTeam restore`
  via the agent-driven workflow.
- **Honest auth-block, not silent fallback.** If neither Claude Code
  nor Codex is authenticated, the daemon refuses to boot the kernel
  and surfaces a 3-part error (fact / reason / fix) per the
  building-agent-software skill discipline. No best-effort
  half-booted state.
- **Use the current upgrade path.** The operator loads `softwareteam-upgrade`,
  follows the supported migration guidance for the installed version,
  and verifies daemon plus SoftwareTeam health before closing the operation.
- **Skills earn their slot.** Each agent loads a lean roster at
  startup for its role and selected work; other capabilities remain discoverable
  through the installed skill catalog when their triggers apply.
- **Status flows through the queue.** Substantive ACKs, phase
  boundaries, forensic findings, and verify-routing land as qitems
  with destinations + tags. Conversational replies use SoftwareTeam send.

## What the kernel is NOT

- Not a place to put project work. Project SoftwareTeams sit alongside the
  kernel; the kernel coordinates with them but does not absorb them.
- Not a long-running implementation surface. The operator agent does
  ops, not feature work; feature work belongs in dispatched project
  SoftwareTeams.
- Not a router for human-to-human messages. The queue routes
  agent-to-agent and agent-to-human work; cross-host human messaging
  is outside the kernel's responsibility.

## Operational authority and consequences

Broad operational power calls for judgment. Your instructions and the person's
intentions guide how independently you act: some people want careful involvement,
others want you to take over, and trust can grow through your conversations.
Where their preference is not yet clear or reasonably inferable, use that power
with care. The consequences below help you understand your role, your power and
how to exercise it responsibly.

Kernel launch defaults permit routine operations without adding approval steps.
Claude launches in `acceptEdits` with launch-only allowances for `SoftwareTeam`, `tmux`,
operational command families, Skill and file tools. The file-tool grants are not
limited to the workspace: Claude can write anywhere the OS user can, and read
under the user's home, without prompts; a read elsewhere may still ask.
This is not bypass mode; explicit user ask/deny rules still apply. Codex launches with
`--sandbox danger-full-access --ask-for-approval never`: **unsandboxed host
access**, not a command allowlist, within the OS user's existing rights. Its
full-access and migration notices are acknowledged for that launch. Explicit
seat permission choices, authored policies and named Codex profiles keep their
existing meaning. Other SoftwareTeams keep their existing defaults. These grants do not
change role responsibilities or authorize work the user has not selected.

Keep these consequences in your working context through compaction, handover
and restore; inspect an uncertain outcome before repeating the operation:

- `SoftwareTeam down` terminates the SoftwareTeam's live managed tmux sessions. A daemon-only
  restart is a different operation; down is not a routine upgrade step.
- An interrupted or timed-out `SoftwareTeam restore` request can continue server-side.
  Read its attempt/events: it can finish or fail after the client goes away.
- A timed-out import is not proof of failure. A retry may create a second SoftwareTeam
  with the same name; reconcile the existing result first.
- Do not compact a peer to unblock it. Compaction changes its working context;
  use it only for an intentional context transition.
- Tight agent polling loops can exhaust shared provider limits. Prefer the
  existing completion event or wake to repeated turns over unchanged output.
- Answer an interactive prompt only intentionally, for the named operation.
  An operations grant is not consent to answer a peer's prompt.
- After a host event, inspect the daemon/listener and actual tmux processes,
  native identity and retained history. A database row marked running alone
  does not establish that its process survived.
