import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useRouterState } from "@tanstack/react-router";

export interface SpecsDraft {
  id: string;
  kind: "softwareTeam" | "agent";
  label: string;
  yaml: string;
  updatedAt: number;
}

export interface SpecsTask {
  id: "import" | "bootstrap" | "validate-agent";
  label: string;
  route: "/import" | "/bootstrap" | "/agents/validate";
  summary: string;
}

interface SpecsWorkspaceValue {
  activeTask: SpecsTask | null;
  currentSoftwareTeamDraft: SpecsDraft | null;
  currentAgentDraft: SpecsDraft | null;
  recentSoftwareTeamDrafts: SpecsDraft[];
  recentAgentDrafts: SpecsDraft[];
  selectedSoftwareTeamDraft: SpecsDraft | null;
  selectedAgentDraft: SpecsDraft | null;
  bootstrapSourceRef: string;
  saveSoftwareTeamDraft: (yaml: string, label?: string) => void;
  rememberSoftwareTeamDraft: (yaml: string, label?: string) => void;
  selectSoftwareTeamDraft: (draftId: string) => void;
  clearSelectedSoftwareTeamDraft: () => void;
  saveAgentDraft: (yaml: string, label?: string) => void;
  rememberAgentDraft: (yaml: string, label?: string) => void;
  selectAgentDraft: (draftId: string) => void;
  clearSelectedAgentDraft: () => void;
  setBootstrapSourceRef: (sourceRef: string) => void;
}

export const SPECS_WORKSPACE_STORAGE_KEYS = {
  currentSoftwareTeamDraft: "softwareteam.specs.current-software-team-draft",
  currentAgentDraft: "softwareteam.specs.current-agent-draft",
  recentSoftwareTeamDrafts: "softwareteam.specs.recent-software-team-drafts",
  recentAgentDrafts: "softwareteam.specs.recent-agent-drafts",
  bootstrapSourceRef: "softwareteam.specs.bootstrap-source-ref",
} as const;

const LEGACY_SPECS_WORKSPACE_STORAGE_KEYS: Record<keyof typeof SPECS_WORKSPACE_STORAGE_KEYS, string> = {
  currentSoftwareTeamDraft: "softwareteam.specs.current-software-team-draft",
  currentAgentDraft: "softwareteam.specs.current-agent-draft",
  recentSoftwareTeamDrafts: "softwareteam.specs.recent-software-team-drafts",
  recentAgentDrafts: "softwareteam.specs.recent-agent-drafts",
  bootstrapSourceRef: "softwareteam.specs.bootstrap-source-ref",
};

const DEFAULT_SPECS_WORKSPACE: SpecsWorkspaceValue = {
  activeTask: null,
  currentSoftwareTeamDraft: null,
  currentAgentDraft: null,
  recentSoftwareTeamDrafts: [],
  recentAgentDrafts: [],
  selectedSoftwareTeamDraft: null,
  selectedAgentDraft: null,
  bootstrapSourceRef: "",
  saveSoftwareTeamDraft: () => {},
  rememberSoftwareTeamDraft: () => {},
  selectSoftwareTeamDraft: () => {},
  clearSelectedSoftwareTeamDraft: () => {},
  saveAgentDraft: () => {},
  rememberAgentDraft: () => {},
  selectAgentDraft: () => {},
  clearSelectedAgentDraft: () => {},
  setBootstrapSourceRef: () => {},
};

const SpecsWorkspaceContext = createContext<SpecsWorkspaceValue>(DEFAULT_SPECS_WORKSPACE);

function loadStoredValue<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw) return JSON.parse(raw) as T;

    const legacyKey = (
      Object.entries(SPECS_WORKSPACE_STORAGE_KEYS).find(([, currentKey]) => currentKey === key)?.[0]
      ?? null
    ) as keyof typeof LEGACY_SPECS_WORKSPACE_STORAGE_KEYS | null;
    if (!legacyKey) return fallback;

    const legacyStorageKey = LEGACY_SPECS_WORKSPACE_STORAGE_KEYS[legacyKey];
    if (!legacyStorageKey) return fallback;
    const legacyRaw = window.localStorage.getItem(legacyStorageKey);
    if (!legacyRaw) return fallback;

    const parsed = JSON.parse(legacyRaw) as T;
    window.localStorage.setItem(key, JSON.stringify(parsed));
    window.localStorage.removeItem(legacyStorageKey);
    return parsed;
  } catch {
    return fallback;
  }
}

function persistStoredValue(key: string, value: unknown) {
  if (typeof window === "undefined") return;
  try {
    if (value === "" || value === null) {
      window.localStorage.removeItem(key);
      return;
    }
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Best effort only for local working state.
  }
}

function createDraft(kind: "softwareTeam" | "agent", yaml: string, label?: string): SpecsDraft {
  return {
    id: `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind,
    label: label ?? (kind === "softwareTeam" ? "Untitled SoftwareTeamSpec" : "Untitled AgentSpec"),
    yaml,
    updatedAt: Date.now(),
  };
}

function extractSpecLabel(yaml: string, fallback: string): string {
  const match = yaml.match(/^\s*name:\s*["']?([^"'\n#]+)["']?/m);
  return match?.[1]?.trim() || fallback;
}

function upsertRecentDrafts(list: SpecsDraft[], draft: SpecsDraft): SpecsDraft[] {
  return [draft, ...list.filter((item) => item.id !== draft.id && item.yaml !== draft.yaml)].slice(0, 5);
}

function buildActiveTask(
  pathname: string,
  currentSoftwareTeamDraft: SpecsDraft | null,
  currentAgentDraft: SpecsDraft | null,
  bootstrapSourceRef: string,
): SpecsTask | null {
  if (pathname === "/import") {
    if (!currentSoftwareTeamDraft) return null;
    return {
      id: "import",
      label: "Import SoftwareTeamSpec",
      route: "/import",
      summary: currentSoftwareTeamDraft.label,
    };
  }

  if (pathname === "/bootstrap") {
    const trimmedSourceRef = bootstrapSourceRef.trim();
    if (!trimmedSourceRef) return null;
    return {
      id: "bootstrap",
      label: "Bootstrap",
      route: "/bootstrap",
      summary: trimmedSourceRef,
    };
  }

  if (pathname === "/agents/validate") {
    if (!currentAgentDraft) return null;
    return {
      id: "validate-agent",
      label: "Validate AgentSpec",
      route: "/agents/validate",
      summary: currentAgentDraft.label,
    };
  }

  return null;
}

export function SpecsWorkspaceProvider({ children }: { children: ReactNode }) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [currentSoftwareTeamDraft, setCurrentSoftwareTeamDraft] = useState<SpecsDraft | null>(() =>
    loadStoredValue<SpecsDraft | null>(SPECS_WORKSPACE_STORAGE_KEYS.currentSoftwareTeamDraft, null)
  );
  const [currentAgentDraft, setCurrentAgentDraft] = useState<SpecsDraft | null>(() =>
    loadStoredValue<SpecsDraft | null>(SPECS_WORKSPACE_STORAGE_KEYS.currentAgentDraft, null)
  );
  const [recentSoftwareTeamDrafts, setRecentSoftwareTeamDrafts] = useState<SpecsDraft[]>(() =>
    loadStoredValue<SpecsDraft[]>(SPECS_WORKSPACE_STORAGE_KEYS.recentSoftwareTeamDrafts, [])
  );
  const [recentAgentDrafts, setRecentAgentDrafts] = useState<SpecsDraft[]>(() =>
    loadStoredValue<SpecsDraft[]>(SPECS_WORKSPACE_STORAGE_KEYS.recentAgentDrafts, [])
  );
  const [selectedSoftwareTeamDraftId, setSelectedSoftwareTeamDraftId] = useState<string | null>(null);
  const [selectedAgentDraftId, setSelectedAgentDraftId] = useState<string | null>(null);
  const [bootstrapSourceRef, setBootstrapSourceRefState] = useState(() =>
    loadStoredValue<string>(SPECS_WORKSPACE_STORAGE_KEYS.bootstrapSourceRef, "")
  );

  useEffect(() => {
    persistStoredValue(SPECS_WORKSPACE_STORAGE_KEYS.currentSoftwareTeamDraft, currentSoftwareTeamDraft);
  }, [currentSoftwareTeamDraft]);

  useEffect(() => {
    persistStoredValue(SPECS_WORKSPACE_STORAGE_KEYS.currentAgentDraft, currentAgentDraft);
  }, [currentAgentDraft]);

  useEffect(() => {
    persistStoredValue(SPECS_WORKSPACE_STORAGE_KEYS.recentSoftwareTeamDrafts, recentSoftwareTeamDrafts);
  }, [recentSoftwareTeamDrafts]);

  useEffect(() => {
    persistStoredValue(SPECS_WORKSPACE_STORAGE_KEYS.recentAgentDrafts, recentAgentDrafts);
  }, [recentAgentDrafts]);

  useEffect(() => {
    persistStoredValue(SPECS_WORKSPACE_STORAGE_KEYS.bootstrapSourceRef, bootstrapSourceRef.trim());
  }, [bootstrapSourceRef]);

  const selectedSoftwareTeamDraft = useMemo(
    () =>
      recentSoftwareTeamDrafts.find((draft) => draft.id === selectedSoftwareTeamDraftId)
      ?? (currentSoftwareTeamDraft?.id === selectedSoftwareTeamDraftId ? currentSoftwareTeamDraft : null),
    [currentSoftwareTeamDraft, recentSoftwareTeamDrafts, selectedSoftwareTeamDraftId],
  );

  const selectedAgentDraft = useMemo(
    () =>
      recentAgentDrafts.find((draft) => draft.id === selectedAgentDraftId)
      ?? (currentAgentDraft?.id === selectedAgentDraftId ? currentAgentDraft : null),
    [currentAgentDraft, recentAgentDrafts, selectedAgentDraftId],
  );

  const saveSoftwareTeamDraft = useCallback((yaml: string, label?: string) => {
    if (!yaml.trim()) {
      setCurrentSoftwareTeamDraft(null);
      return;
    }

    setCurrentSoftwareTeamDraft((existing) => ({
      id: existing?.id ?? createDraft("softwareTeam", yaml, label).id,
      kind: "softwareTeam",
      label: label ?? extractSpecLabel(yaml, existing?.label ?? "Untitled SoftwareTeamSpec"),
      yaml,
      updatedAt: Date.now(),
    }));
  }, []);

  const rememberSoftwareTeamDraft = useCallback((yaml: string, label?: string) => {
    if (!yaml.trim()) return;
    const draft = createDraft("softwareTeam", yaml, label ?? extractSpecLabel(yaml, "Untitled SoftwareTeamSpec"));
    setCurrentSoftwareTeamDraft(draft);
    setRecentSoftwareTeamDrafts((existing) => upsertRecentDrafts(existing, draft));
    setSelectedSoftwareTeamDraftId(draft.id);
  }, []);

  const saveAgentDraft = useCallback((yaml: string, label?: string) => {
    if (!yaml.trim()) {
      setCurrentAgentDraft(null);
      return;
    }

    setCurrentAgentDraft((existing) => ({
      id: existing?.id ?? createDraft("agent", yaml, label).id,
      kind: "agent",
      label: label ?? extractSpecLabel(yaml, existing?.label ?? "Untitled AgentSpec"),
      yaml,
      updatedAt: Date.now(),
    }));
  }, []);

  const rememberAgentDraft = useCallback((yaml: string, label?: string) => {
    if (!yaml.trim()) return;
    const draft = createDraft("agent", yaml, label ?? extractSpecLabel(yaml, "Untitled AgentSpec"));
    setCurrentAgentDraft(draft);
    setRecentAgentDrafts((existing) => upsertRecentDrafts(existing, draft));
    setSelectedAgentDraftId(draft.id);
  }, []);

  const selectSoftwareTeamDraft = useCallback((draftId: string) => {
    setSelectedSoftwareTeamDraftId(draftId);
    const draft = recentSoftwareTeamDrafts.find((item) => item.id === draftId)
      ?? (currentSoftwareTeamDraft?.id === draftId ? currentSoftwareTeamDraft : null);
    if (draft) {
      setCurrentSoftwareTeamDraft(draft);
    }
  }, [currentSoftwareTeamDraft, recentSoftwareTeamDrafts]);

  const selectAgentDraft = useCallback((draftId: string) => {
    setSelectedAgentDraftId(draftId);
    const draft = recentAgentDrafts.find((item) => item.id === draftId)
      ?? (currentAgentDraft?.id === draftId ? currentAgentDraft : null);
    if (draft) {
      setCurrentAgentDraft(draft);
    }
  }, [currentAgentDraft, recentAgentDrafts]);

  const value = useMemo<SpecsWorkspaceValue>(() => ({
    activeTask: buildActiveTask(pathname, currentSoftwareTeamDraft, currentAgentDraft, bootstrapSourceRef),
    currentSoftwareTeamDraft,
    currentAgentDraft,
    recentSoftwareTeamDrafts,
    recentAgentDrafts,
    selectedSoftwareTeamDraft,
    selectedAgentDraft,
    bootstrapSourceRef,
    saveSoftwareTeamDraft,
    rememberSoftwareTeamDraft,
    selectSoftwareTeamDraft,
    clearSelectedSoftwareTeamDraft: () => setSelectedSoftwareTeamDraftId(null),
    saveAgentDraft,
    rememberAgentDraft,
    selectAgentDraft,
    clearSelectedAgentDraft: () => setSelectedAgentDraftId(null),
    setBootstrapSourceRef: setBootstrapSourceRefState,
  }), [
    pathname,
    currentSoftwareTeamDraft,
    currentAgentDraft,
    recentSoftwareTeamDrafts,
    recentAgentDrafts,
    selectedSoftwareTeamDraft,
    selectedAgentDraft,
    bootstrapSourceRef,
    saveSoftwareTeamDraft,
    rememberSoftwareTeamDraft,
    selectSoftwareTeamDraft,
    saveAgentDraft,
    rememberAgentDraft,
    selectAgentDraft,
  ]);

  return (
    <SpecsWorkspaceContext.Provider value={value}>
      {children}
    </SpecsWorkspaceContext.Provider>
  );
}

export function useSpecsWorkspace() {
  return useContext(SpecsWorkspaceContext);
}
