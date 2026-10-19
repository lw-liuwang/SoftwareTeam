// OPR.0.4.3.22 — the reusable software-team-status card. Renders the COMPOSED backend
// aggregate (up / partial / down / blocked / unknown), NOT inferred from pane
// text. Used in two places: the dashboard kernel-status card and the topology
// softwareTeam control. The card exposes ONE primary recovery/launch action (opens the
// launch/recovery modal); terminal-surface actions (Open topology / CMUX) live
// SEPARATELY, never on this card (guard 5).
//
// The status badge CONSUMES the backend verdict in its rendered tone — a
// non-`up` status renders non-green (the 19/21 lesson: render the verdict, don't
// default to green while carrying it in data).

import { Hexagon, Server } from "lucide-react";
import { StatusPip, type StatusPipStatus } from "./ui/status-pip.js";
import { Button } from "./ui/button.js";
import { cn } from "../lib/utils.js";
import type { SoftwareTeamAggStatus } from "../hooks/useSoftwareTeamStatus.js";

// Shared status vocabulary — also consumed by the compact topology
// SoftwareTeamStatusControl (OPR.0.4.7.1) so both surfaces render one verdict language.
export const statusToPip: Record<SoftwareTeamAggStatus, StatusPipStatus> = {
  up: "running",
  partial: "warning",
  down: "stopped",
  blocked: "error",
  unknown: "info",
};

export const statusBadgeTone: Record<SoftwareTeamAggStatus, string> = {
  up: "border-success text-success",
  partial: "border-warning text-warning",
  down: "border-stone-400 text-stone-500",
  blocked: "border-tertiary text-tertiary",
  unknown: "border-stone-300 text-stone-400",
};

export const statusHelp: Record<SoftwareTeamAggStatus, string> = {
  up: "All managed seats are running.",
  partial: "Some seats running, some stopped / detached / attention-required.",
  down: "No seats running — recoverable from snapshot.",
  blocked: "Restore cannot proceed without operator action (missing token / auth / spec).",
  unknown: "Daemon/API cannot confidently compute the state.",
};

export interface SoftwareTeamStatusCardProps {
  softwareTeamId: string;
  softwareTeamName: string;
  isKernel?: boolean;
  status: SoftwareTeamAggStatus;
  seatsRunning: number;
  seatsTotal: number;
  recoverable: boolean;
  /** The composed provenance line(s) — visible so the state is legible, not just a color. */
  src: string[];
  primaryLabel: string;
  onPrimary?: () => void;
  /** Override the enablement (e.g. the kernel card disables restore when no
   *  kernel softwareTeam exists — the double-instantiation guard). Defaults to disabled
   *  only when the softwareTeam is already `up`. */
  primaryDisabled?: boolean;
  testId?: string;
}

export function SoftwareTeamStatusCard({
  softwareTeamId,
  softwareTeamName,
  isKernel = false,
  status,
  seatsRunning,
  seatsTotal,
  recoverable,
  src,
  primaryLabel,
  onPrimary,
  primaryDisabled,
  testId,
}: SoftwareTeamStatusCardProps) {
  const pip = statusToPip[status];
  const disabled = primaryDisabled ?? status === "up";

  return (
    <div
      data-testid={testId ?? `software-team-status-card-${softwareTeamId}`}
      data-status={status}
      className="bg-white border border-stone-900 hard-shadow relative"
    >
      {/* Dark header stripe — vellum grammar (matches SoftwareTeamCard). */}
      <div className="bg-stone-900 text-white px-4 py-1.5 font-mono text-[10px] flex justify-between items-center">
        <span>{isKernel ? "KERNEL SOFTWARE_TEAM" : `SOFTWARE_TEAM: ${softwareTeamName.toUpperCase()}`}</span>
        {isKernel ? <Hexagon className="h-3 w-3" /> : <Server className="h-3 w-3" />}
      </div>

      <div className="p-4 space-y-3">
        {/* Name + aggregate status badge (the badge tone CONSUMES the verdict). */}
        <div className="flex justify-between items-end border-b border-stone-100 pb-2">
          <span className="font-headline font-bold text-lg tracking-tight uppercase">{softwareTeamName}</span>
          <span
            data-testid={`software-team-status-badge-${softwareTeamId}`}
            className={cn(
              "px-2 py-0.5 border font-mono text-[9px] uppercase tracking-wide inline-flex items-center gap-1.5",
              statusBadgeTone[status],
            )}
          >
            <StatusPip status={pip} />
            {status}
          </span>
        </div>

        {/* One-line meaning of the status. */}
        <p className="font-mono text-[9px] leading-relaxed text-secondary">{statusHelp[status]}</p>

        {/* Telemetry grid. */}
        <div className="space-y-1">
          <div className="flex justify-between font-mono text-[9px] text-secondary">
            <span>SEATS RUNNING</span>
            <span data-testid={`seats-${softwareTeamId}`}>
              {seatsRunning}/{seatsTotal}
            </span>
          </div>
          <div className="flex justify-between font-mono text-[9px] text-secondary">
            <span>RECOVERABLE</span>
            <span>{recoverable ? "yes" : "no — needs operator"}</span>
          </div>
        </div>

        {/* Primary recovery/launch action — the ONE thing this card does. */}
        <div className="pt-1">
          <Button
            variant={status === "blocked" ? "destructive" : "default"}
            size="sm"
            disabled={disabled}
            onClick={onPrimary}
            data-testid={`software-team-primary-action-${softwareTeamId}`}
            className="w-full font-mono text-[10px] tracking-widest"
          >
            {status === "up" ? "RUNNING" : primaryLabel}
          </Button>
        </div>

        {/* Provenance — the composed source signals (composed, not inferred). */}
        <p
          data-testid={`software-team-status-src-${softwareTeamId}`}
          className="font-mono text-[8px] leading-snug text-stone-400 border-t border-stone-100 pt-2"
        >
          src: {src.join(" · ")}
        </p>
      </div>
    </div>
  );
}
