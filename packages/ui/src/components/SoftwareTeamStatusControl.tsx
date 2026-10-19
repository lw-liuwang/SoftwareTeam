// OPR.0.4.7.1 — the topology software-team-status control: a COMPACT status badge +
// launch button that opens the existing LaunchRecoveryModal.
//
// Replaces the inline SoftwareTeamStatusCard mount, which rendered as a large
// left-anchored card underneath the topology explorer overlay (reproduced:
// the card started at x335 with its left half, text, and action obscured).
// SoftwareTeamStatusCard itself is untouched — the dashboard kernel card still uses
// it (OPR.0.4.3.22). Terminal-surface actions (Open in terminal) still live
// SEPARATELY in the tab bar and never restore or fresh-prime (guard 5).
//
// The control stays a BUTTON in every state — status=up opens the modal too:
// the modal is plan-before-mutation (a read-only forecast on open), so
// opening it while up is safe, and a control that sometimes isn't clickable
// reads as broken. The one-line status meaning rides the badge tooltip.

import { useState } from "react";
import { LaunchRecoveryModal } from "./LaunchRecoveryModal.js";
import { statusBadgeTone, statusHelp, statusToPip } from "./SoftwareTeamStatusCard.js";
import { StatusPip } from "./ui/status-pip.js";
import { Button } from "./ui/button.js";
import { cn } from "../lib/utils.js";
import { useSoftwareTeamStatus } from "../hooks/useSoftwareTeamStatus.js";

export function SoftwareTeamStatusControl({ softwareTeamId, softwareTeamName }: { softwareTeamId: string; softwareTeamName: string }) {
  const { data: status, isLoading } = useSoftwareTeamStatus(softwareTeamId);
  const [modalOpen, setModalOpen] = useState(false);

  // Defensive: render the placeholder until a well-formed status object arrives
  // (a malformed/empty response must never crash the topology page).
  if (isLoading || !status || typeof status.softwareTeamName !== "string" || !Array.isArray(status.src)) {
    return (
      <div
        data-testid={`software-team-status-control-${softwareTeamId}`}
        className="inline-flex items-center border border-stone-300 bg-white/60 px-3 py-1.5 font-mono text-[9px] text-secondary"
      >
        Loading SoftwareTeam status…
      </div>
    );
  }

  const primaryLabel =
    status.status === "blocked"
      ? "Resolve & restore ▸"
      : status.status === "up"
        ? "Running ▸"
        : "Restore / launch ▸";

  return (
    <div
      data-testid={`software-team-status-control-${softwareTeamId}`}
      data-status={status.status}
      className="inline-flex items-center gap-2 border border-stone-900 bg-white hard-shadow px-2 py-1.5"
    >
      <span
        data-testid={`software-team-status-badge-${softwareTeamId}`}
        title={statusHelp[status.status]}
        className={cn(
          "px-2 py-0.5 border font-mono text-[9px] uppercase tracking-wide inline-flex items-center gap-1.5",
          statusBadgeTone[status.status],
        )}
      >
        <StatusPip status={statusToPip[status.status]} />
        {status.status}
      </span>
      <span data-testid={`seats-${softwareTeamId}`} className="font-mono text-[9px] text-secondary">
        {status.seatsRunning}/{status.seatsTotal}
      </span>
      <Button
        variant={status.status === "blocked" ? "destructive" : "default"}
        size="sm"
        onClick={() => setModalOpen(true)}
        data-testid={`software-team-primary-action-${softwareTeamId}`}
        className="font-mono text-[10px] tracking-widest"
      >
        {primaryLabel}
      </Button>
      <LaunchRecoveryModal softwareTeamId={softwareTeamId} softwareTeamName={softwareTeamName} open={modalOpen} onOpenChange={setModalOpen} />
    </div>
  );
}
