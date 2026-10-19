import { useMutation, useQueryClient } from "@tanstack/react-query";

export class ImportError extends Error {
  errors: string[];
  warnings: string[];
  code: string;

  constructor(data: { code?: string; errors?: string[]; warnings?: string[]; message?: string }) {
    const msg = data.errors?.join(", ") ?? data.message ?? "Import failed";
    super(msg);
    this.name = "ImportError";
    this.code = data.code ?? "unknown";
    this.errors = data.errors ?? (data.message ? [data.message] : ["Import failed"]);
    this.warnings = data.warnings ?? [];
  }
}

export class RestoreError extends Error {
  code: string;

  constructor(data: { code?: string; error?: string }, status: number) {
    super(data.error ?? `HTTP ${status}`);
    this.name = "RestoreError";
    this.code = data.code ?? "unknown";
  }
}

export function useCreateSnapshot(softwareTeamId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/software-teams/${encodeURIComponent(softwareTeamId)}/snapshots`, { method: "POST" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error ?? `Snapshot failed (HTTP ${res.status})`);
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["softwareTeam", softwareTeamId, "snapshots"] });
      queryClient.invalidateQueries({ queryKey: ["softwareTeams", "summary"] });
    },
  });
}

export function useRestoreSnapshot(softwareTeamId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (snapshotId: string) => {
      const res = await fetch(`/api/software-teams/${encodeURIComponent(softwareTeamId)}/restore/${encodeURIComponent(snapshotId)}`, { method: "POST" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new RestoreError(data as { code?: string; error?: string }, res.status);
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["softwareTeam", softwareTeamId] });
    },
  });
}

export function useTeardownSoftwareTeam(softwareTeamId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/down", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ softwareTeamId }),
      });
      const data = await res.json().catch(() => ({})) as {
        errors?: string[];
        error?: string;
        sessionsKilled?: number;
      };
      if (!res.ok) {
        throw new Error(data.error ?? `Teardown failed (HTTP ${res.status})`);
      }
      // Body-driven: errors[] on 200 is a failure
      if (Array.isArray(data.errors) && data.errors.length > 0) {
        throw new Error(data.errors.join("; "));
      }
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["softwareTeams", "summary"] });
      queryClient.invalidateQueries({ queryKey: ["ps"] });
    },
  });
}

export function useStartSoftwareTeam(softwareTeamId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/software-teams/${encodeURIComponent(softwareTeamId)}/up`, { method: "POST" });
      const data = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok) {
        throw new Error(data.error ?? `Start failed (HTTP ${res.status})`);
      }
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["softwareTeams", "summary"] });
      queryClient.invalidateQueries({ queryKey: ["ps"] });
      queryClient.invalidateQueries({ queryKey: ["softwareTeam", softwareTeamId] });
    },
  });
}

/**
 * OPR.0.4.3.22 — the policy-carrying launch/restore mutation the launch/recovery
 * modal executes AFTER the operator has seen the read-only plan. POSTs
 * /api/software-teams/:id/up with an explicit body carrying `freshLogicalIds` (the per-seat
 * fresh list — the LOCK: fresh is only ever a per-seat list, never a global flip).
 *
 * This is DISTINCT from `useStartSoftwareTeam`, which stays a bodyless default `/up` POST.
 * The modal never routes through `useStartSoftwareTeam`, so the default restore behavior
 * is not silently changed (guard 3).
 */
export function useLaunchSoftwareTeam(softwareTeamId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (freshLogicalIds?: string[]) => {
      const res = await fetch(`/api/software-teams/${encodeURIComponent(softwareTeamId)}/up`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(freshLogicalIds && freshLogicalIds.length > 0 ? { freshLogicalIds } : {}),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
      if (!res.ok) {
        throw new RestoreError(data as { code?: string; error?: string }, res.status);
      }
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["softwareTeams", "summary"] });
      queryClient.invalidateQueries({ queryKey: ["ps"] });
      queryClient.invalidateQueries({ queryKey: ["softwareTeam", softwareTeamId] });
      queryClient.invalidateQueries({ queryKey: ["kernel", "status"] });
    },
  });
}

export function useImportSoftwareTeam() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ yaml, softwareTeamRoot }: { yaml: string; softwareTeamRoot?: string }) => {
      const headers: Record<string, string> = { "Content-Type": "text/yaml" };
      if (softwareTeamRoot) headers["X-Software-Team-Root"] = softwareTeamRoot;
      const res = await fetch("/api/software-teams/import", {
        method: "POST",
        headers,
        body: yaml,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { code?: string; errors?: string[]; warnings?: string[]; message?: string };
        if (data.code === "cycle_error") {
          throw new ImportError({ ...data, errors: data.errors ?? ["Cycle detected in SoftwareTeam topology"] });
        }
        throw new ImportError(data);
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["softwareTeams", "summary"] });
    },
  });
}

export interface ExpandSoftwareTeamResult {
  ok: boolean;
  status?: "ok" | "partial" | "failed";
  podId?: string;
  podNamespace?: string;
  nodes?: Array<{ logicalId: string; nodeId: string; status: string; error?: string; sessionName?: string }>;
  warnings?: string[];
  retryTargets?: string[];
  code?: string;
  error?: string;
}

export function useExpandSoftwareTeam() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ softwareTeamId, pod, crossPodEdges }: { softwareTeamId: string; pod: Record<string, unknown>; crossPodEdges?: unknown[] }) => {
      const res = await fetch(`/api/software-teams/${encodeURIComponent(softwareTeamId)}/expand`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pod, crossPodEdges }),
      });
      const data = await res.json() as ExpandSoftwareTeamResult;
      if (res.status >= 400 || !data.ok) {
        throw new Error(data.error ?? `Expansion failed (HTTP ${res.status})`);
      }
      return data;
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["softwareTeams", "summary"] });
      queryClient.invalidateQueries({ queryKey: ["ps"] });
      queryClient.invalidateQueries({ queryKey: ["softwareTeam", variables.softwareTeamId, "nodes"] });
      queryClient.invalidateQueries({ queryKey: ["softwareTeam", variables.softwareTeamId, "graph"] });
    },
  });
}

export function useRemoveLibrarySpec() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (entryId: string) => {
      const res = await fetch(`/api/specs/library/${encodeURIComponent(entryId)}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok) {
        throw new Error(data.error ?? `Remove failed (HTTP ${res.status})`);
      }
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["spec-library"] });
    },
  });
}

export function useRenameLibrarySpec() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ entryId, name }: { entryId: string; name: string }) => {
      const res = await fetch(`/api/specs/library/${encodeURIComponent(entryId)}/rename`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok) {
        throw new Error(data.error ?? `Rename failed (HTTP ${res.status})`);
      }
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["spec-library"] });
    },
  });
}
