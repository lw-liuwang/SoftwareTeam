// OPR.0.4.3.22 — dashboard kernel-status card.
//
// Kernel health comes from /api/kernel/status (the boot-tracker surface), NEVER
// inferred from the daemon /healthz check (guard 4). The card CONSUMES the
// kernel_state verdict in its rendered badge tone — a non-ready kernel renders
// non-green (the 19/21 lesson: render the verdict, don't default to green while
// carrying it in data).
//
// "Restore kernel" opens the same launch/recovery modal against the kernel softwareTeam.
// Double-instantiation guard: the action is disabled unless a kernel softwareTeam exists
// (found via the softwareTeam summary) AND the kernel is not already up; the restore
// itself routes through /api/software-teams/:id/up, whose `software_team_not_stopped` guard refuses
// to restore a running kernel (so no second kernel/advisor/operator is spawned).

import { useState } from "react";
import { SoftwareTeamStatusCard } from "./SoftwareTeamStatusCard.js";
import { LaunchRecoveryModal } from "./LaunchRecoveryModal.js";
import { useKernelStatus, isKernelUnavailable, type KernelState } from "../hooks/useKernelStatus.js";
import { useSoftwareTeamSummary } from "../hooks/useSoftwareTeamSummary.js";
import type { SoftwareTeamAggStatus } from "../hooks/useSoftwareTeamStatus.js";

function kernelToAggregate(state: KernelState | undefined): SoftwareTeamAggStatus {
  switch (state) {
    case "ready":
      return "up";
    case "booting":
    case "partial_ready":
    case "degraded":
      return "partial";
    case "auth_blocked":
    case "spec_missing":
    case "bootstrap_failed":
      return "blocked";
    default:
      return "unknown";
  }
}

export function KernelStatusCard() {
  const { data: kernel, isLoading } = useKernelStatus();
  const { data: softwareTeams } = useSoftwareTeamSummary();
  const [modalOpen, setModalOpen] = useState(false);

  const kernelSoftwareTeam = softwareTeams?.find((r) => r.name === "kernel");

  if (isLoading || !kernel) {
    return (
      <SoftwareTeamStatusCard
        softwareTeamId="kernel"
        softwareTeamName="kernel"
        isKernel
        status="unknown"
        seatsRunning={0}
        seatsTotal={0}
        recoverable={false}
        src={["kernel-status: loading…"]}
        primaryLabel="Restore kernel ▸"
        primaryDisabled
        testId="kernel-status-card"
      />
    );
  }

  // 503 — the boot tracker is not wired into this daemon. Consume as `unknown`
  // (never green); restore is not offered (nothing observable to restore).
  if (isKernelUnavailable(kernel)) {
    return (
      <SoftwareTeamStatusCard
        softwareTeamId={kernelSoftwareTeam?.id ?? "kernel"}
        softwareTeamName="kernel"
        isKernel
        status="unknown"
        seatsRunning={0}
        seatsTotal={0}
        recoverable={false}
        src={[`kernel-status: unavailable (${kernel.error})`]}
        primaryLabel="Restore kernel ▸"
        primaryDisabled
        testId="kernel-status-card"
      />
    );
  }

  // Defensive: a malformed envelope (missing kernel_state / agents) reads as
  // `unknown` — never a crash, never a false green.
  const status = kernelToAggregate(kernel.kernel_state);
  const agents = Array.isArray(kernel.agents) ? kernel.agents : [];
  const readyAgents = agents.filter((a) => a.startup_status === "ready").length;
  const src = [
    `kernel-status.kernel_state=${kernel.kernel_state ?? "unknown"}`,
    ...(kernel.variant ? [`variant=${kernel.variant}`] : []),
    `agents ${readyAgents}/${agents.length} ready`,
    ...(kernel.detail ? [kernel.detail] : []),
  ];

  // Double-instantiation guard: restore only when a kernel softwareTeam exists and the
  // kernel is not already up.
  const restoreDisabled = !kernelSoftwareTeam || status === "up";

  return (
    <>
      <SoftwareTeamStatusCard
        softwareTeamId={kernelSoftwareTeam?.id ?? "kernel"}
        softwareTeamName="kernel"
        isKernel
        status={status}
        seatsRunning={readyAgents}
        seatsTotal={agents.length}
        recoverable={status === "down" || status === "partial"}
        src={src}
        primaryLabel="Restore kernel ▸"
        primaryDisabled={restoreDisabled}
        onPrimary={() => setModalOpen(true)}
        testId="kernel-status-card"
      />
      {kernelSoftwareTeam ? (
        <LaunchRecoveryModal
          softwareTeamId={kernelSoftwareTeam.id}
          softwareTeamName="kernel"
          open={modalOpen}
          onOpenChange={setModalOpen}
        />
      ) : null}
    </>
  );
}
