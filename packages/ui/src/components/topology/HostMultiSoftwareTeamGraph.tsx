// V1 polish slice: multi-softwareTeam hybrid /topology graph.
//
// Uses shared dagre helpers to lay out each expanded softwareTeam as a soft frame
// containing pod sub-frames and compact agent leaves, then lays out softwareTeam
// frames on the host canvas. V1 contracts remain load-bearing: lazy
// per-softwareTeam graph fetches, cross-softwareTeam node ID prefixing, collapse persistence,
// URL auto-expand, and graph/tree/table navigate parity.
//
// Default state: softwareTeams expanded so the topology opens as the full fleet
// canvas. Explicit collapse state is still persisted in TopologyOverlayProvider,
// and the operator can collapse / expand every softwareTeam from the canvas controls.
// Auto-expand rule (parity with Phase 5.1 TopologyTreeView):
// when route is /topology/softwareTeam/$softwareTeamId or /topology/seat/$softwareTeamId/* or
// /topology/pod/$softwareTeamId/*, the matching softwareTeam is auto-expanded on mount /
// route change. Click softwareTeam card body -> toggle collapse. Click arrow Link
// on softwareTeam card name -> navigate to /topology/softwareTeam/$softwareTeamId (drill-in).
//
// Performance: per-softwareTeam graph data is lazy-fetched (useQueries enabled
// only when softwareTeam is expanded). The V1 operator default now intentionally
// fetches expanded softwareTeams up front; explicit Collapse All restores the prior
// low-fan-out behavior.

import { useCallback, useEffect, useMemo, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  ReactFlow,
  Controls,
  Panel,
  useReactFlow,
  useNodesInitialized,
  type Node,
  type Edge,
  type NodeTypes,
  type EdgeTypes,
  type NodeMouseHandler,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useQueries } from "@tanstack/react-query";
import { Maximize2, Minimize2 } from "lucide-react";
import { usePsEntries } from "../../hooks/usePsEntries.js";
import { SoftwareTeamGroupNode, type SoftwareTeamGroupNodeData } from "./SoftwareTeamGroupNode.js";
import { HybridAgentNode, HybridPodGroupNode } from "./HybridTopologyNodes.js";
import { HotPotatoEdge } from "./HotPotatoEdge.js";
import { useTopologyOverlay } from "./topology-overlay-context.js";
import { useTopologyActivity } from "../../hooks/useTopologyActivity.js";
import { usePrefersReducedMotion } from "../../hooks/usePrefersReducedMotion.js";
import { useSelectedHostId } from "../../hooks/useHosts.js";
import { withHostParam } from "../../lib/host-param.js";
import {
  HYBRID_COLLAPSED_SOFTWARE_TEAM_HEIGHT,
  HYBRID_COLLAPSED_SOFTWARE_TEAM_WIDTH,
  layoutHybridOuterSoftwareTeams,
  layoutHybridSoftwareTeam,
} from "../../lib/hybrid-layout.js";
import {
  applyHotPotatoEdges,
  buildTopologySessionIndex,
  type TopologyActivityBaseline,
} from "../../lib/topology-activity.js";

interface GraphData {
  nodes: unknown[];
  edges: unknown[];
}

async function fetchGraph(softwareTeamId: string, hostId: string): Promise<GraphData> {
  const res = await fetch(withHostParam(`/api/software-teams/${encodeURIComponent(softwareTeamId)}/graph`, hostId));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const nodeTypes: NodeTypes = {
  softwareTeamGroup: SoftwareTeamGroupNode as unknown as NodeTypes[string],
  podGroup: HybridPodGroupNode as unknown as NodeTypes[string],
  softwareTeamNode: HybridAgentNode as unknown as NodeTypes[string],
};

const edgeTypes: EdgeTypes = {
  hotPotato: HotPotatoEdge,
};

const DEFAULT_SOFTWARE_TEAM_EXPANDED = true;
const HOST_GRAPH_MIN_ZOOM = 0.03;
const HOST_GRAPH_MAX_ZOOM = 2;
const HOST_GRAPH_FIT_PADDING = 0.08;

export function HostMultiSoftwareTeamGraph() {
  const navigate = useNavigate();
  const { data: psEntries } = usePsEntries();
  const hostId = useSelectedHostId();
  const reducedMotion = usePrefersReducedMotion();

  // V1 polish slice Phase 5.2 bounce-fix: software-team-expanded state lifted to
  // TopologyOverlayProvider scope. Direct-URL entry to /topology/softwareTeam/$id
  // (which mounts SoftwareTeamScopePage, NOT HostMultiSoftwareTeamGraph because topology
  // routes are SIBLING) still updates the context's expandedSoftwareTeams map
  // via the provider's auto-expand useEffect; when the operator returns
  // to /topology, this component reads the persisted state via
  // useTopologyOverlay() and renders the matching softwareTeam expanded.
  const { expandedSoftwareTeams: expanded, setSoftwareTeamExpanded } = useTopologyOverlay();
  const isSoftwareTeamExpanded = useCallback(
    (softwareTeamId: string) => expanded.get(softwareTeamId) ?? DEFAULT_SOFTWARE_TEAM_EXPANDED,
    [expanded],
  );
  const toggleSoftwareTeam = useCallback((softwareTeamId: string) => {
    setSoftwareTeamExpanded(softwareTeamId, !isSoftwareTeamExpanded(softwareTeamId));
  }, [isSoftwareTeamExpanded, setSoftwareTeamExpanded]);

  // P5.2-2 + P5.2-3: useQueries for per-softwareTeam graph data; enabled only
  // when the softwareTeam is expanded. Stable hook-call count (single useQueries
  // call) regardless of how psEntries grows from undefined to [N], so
  // no rules-of-hooks regression (P0-1 pattern preserved).
  const softwareTeamList = psEntries ?? [];
  const graphQueries = useQueries({
    queries: softwareTeamList.map((softwareTeam) => ({
      queryKey: ["softwareTeam", softwareTeam.softwareTeamId, "graph", hostId] as const,
      queryFn: () => fetchGraph(softwareTeam.softwareTeamId, hostId),
      enabled: isSoftwareTeamExpanded(softwareTeam.softwareTeamId),
      refetchInterval: 30_000,
    })),
  });
  const expandedCount = useMemo(
    () => softwareTeamList.filter((softwareTeam) => isSoftwareTeamExpanded(softwareTeam.softwareTeamId)).length,
    [softwareTeamList, isSoftwareTeamExpanded],
  );
  const expandAllSoftwareTeams = useCallback(() => {
    for (const softwareTeam of softwareTeamList) setSoftwareTeamExpanded(softwareTeam.softwareTeamId, true);
  }, [softwareTeamList, setSoftwareTeamExpanded]);
  const collapseAllSoftwareTeams = useCallback(() => {
    for (const softwareTeam of softwareTeamList) setSoftwareTeamExpanded(softwareTeam.softwareTeamId, false);
  }, [softwareTeamList, setSoftwareTeamExpanded]);

  // Build per-softwareTeam nested subgraphs and lay out softwareTeam frames on the host canvas.
  const { mergedNodes, mergedEdges } = useMemo(() => {
    type RawN = Node & { data?: Record<string, unknown>; initialWidth?: number; initialHeight?: number };
    type RawE = Edge & { source: string; target: string; data?: Record<string, unknown>; label?: unknown };

    const perSoftwareTeam: Array<{
      softwareTeamId: string;
      softwareTeamName: string;
      status: "running" | "partial" | "stopped";
      nodeCount: number;
      runningCount: number;
      /** Slice 15 — terminal-active count piped through from PsEntry. */
      activeCount?: number;
      podCount?: number;
      isExpanded: boolean;
      childNodes: Node[];
      childEdges: Edge[];
      width: number;
      height: number;
    }> = [];

    for (let i = 0; i < softwareTeamList.length; i++) {
      const softwareTeam = softwareTeamList[i]!;
      const isExpanded = isSoftwareTeamExpanded(softwareTeam.softwareTeamId);
      const queryResult = graphQueries[i];

      let childNodes: Node[] = [];
      let childEdges: Edge[] = [];
      let width = HYBRID_COLLAPSED_SOFTWARE_TEAM_WIDTH;
      let height = HYBRID_COLLAPSED_SOFTWARE_TEAM_HEIGHT;
      let podCount: number | undefined;

      const rawNodes = (queryResult?.data?.nodes ?? []) as RawN[];
      const rawEdges = (queryResult?.data?.edges ?? []) as RawE[];
      const layout = layoutHybridSoftwareTeam({
        softwareTeamId: softwareTeam.softwareTeamId,
        softwareTeamName: softwareTeam.name,
        nodes: rawNodes,
        edges: rawEdges,
        collapsed: !isExpanded,
      });
      width = layout.width;
      height = layout.height;
      if (isExpanded) {
        childNodes = layout.nodes;
        childEdges = layout.edges;
        podCount = layout.podCount;
      }

      perSoftwareTeam.push({
        softwareTeamId: softwareTeam.softwareTeamId,
        softwareTeamName: softwareTeam.name,
        status: softwareTeam.status,
        nodeCount: softwareTeam.nodeCount,
        runningCount: softwareTeam.runningCount,
        activeCount: (softwareTeam as { activeCount?: number }).activeCount,
        podCount,
        isExpanded,
        childNodes,
        childEdges,
        width,
        height,
      });
    }

    const packed = layoutHybridOuterSoftwareTeams(
      perSoftwareTeam.map((p) => ({ softwareTeamId: p.softwareTeamId, width: p.width, height: p.height })),
    );

    const nodes: Node[] = [];
    const edges: Edge[] = [];
    for (let i = 0; i < perSoftwareTeam.length; i++) {
      const p = perSoftwareTeam[i]!;
      const pack = packed[i]!;
      const data: SoftwareTeamGroupNodeData = {
        softwareTeamId: p.softwareTeamId,
        softwareTeamName: p.softwareTeamName,
        collapsed: !p.isExpanded,
        status: p.status,
        nodeCount: p.nodeCount,
        runningCount: p.runningCount,
        activeCount: p.activeCount,
        podCount: p.podCount,
        onToggle: toggleSoftwareTeam,
      };
      nodes.push({
        id: `software-team-${p.softwareTeamId}`,
        type: "softwareTeamGroup",
        position: pack.position,
        data: data as unknown as Record<string, unknown>,
        style: { width: pack.width, height: pack.height },
        draggable: false,
        zIndex: 0,
      });
      if (p.isExpanded) {
        nodes.push(...p.childNodes);
        edges.push(...p.childEdges);
      }
    }

    return { mergedNodes: nodes, mergedEdges: edges };
    // toggleSoftwareTeam is stable per-render but useMemo doesn't know; safe to
    // include softwareTeamList + expanded + graphQueries as deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [softwareTeamList, isSoftwareTeamExpanded, graphQueries]);

  const sessionIndex = useMemo(() => buildTopologySessionIndex(
    mergedNodes
      .filter((node) => node.type === "softwareTeamNode")
      .map((node) => {
        const data = node.data as {
          softwareTeamId?: string | null;
          softwareTeamName?: string | null;
          logicalId?: string | null;
          canonicalSessionName?: string | null;
          agentActivity?: TopologyActivityBaseline["agentActivity"];
          currentQitems?: TopologyActivityBaseline["currentQitems"];
          startupStatus?: string | null;
          terminalActive?: boolean | null;
          hasAssignedWork?: boolean;
          pendingWorkCount?: number;
        } | undefined;
        return {
          nodeId: node.id,
          softwareTeamId: data?.softwareTeamId ?? null,
          softwareTeamName: data?.softwareTeamName ?? null,
          logicalId: data?.logicalId ?? null,
          canonicalSessionName: data?.canonicalSessionName ?? null,
          agentActivity: data?.agentActivity ?? null,
          currentQitems: data?.currentQitems ?? null,
          startupStatus: data?.startupStatus ?? null,
          terminalActive: data?.terminalActive,
          hasAssignedWork: data?.hasAssignedWork ?? false,
          pendingWorkCount: data?.pendingWorkCount ?? 0,
        };
      }),
  ), [mergedNodes]);
  const topologyActivity = useTopologyActivity(sessionIndex);

  const activeNodes = useMemo(() => mergedNodes.map((node) => {
    if (node.type === "softwareTeamGroup") {
      const data = node.data as unknown as SoftwareTeamGroupNodeData;
      return {
        ...node,
        data: {
          ...data,
          recentActivity: topologyActivity.isSoftwareTeamRecentlyActive(data.softwareTeamId),
        } as unknown as Record<string, unknown>,
      };
    }
    if (node.type !== "softwareTeamNode") return node;
    const data = node.data as TopologyActivityBaseline & {
      logicalId?: string | null;
    };
    return {
      ...node,
      data: {
        ...(node.data ?? {}),
        activityRing: topologyActivity.getNodeActivity(node.id, data),
        reducedMotion,
      },
    };
  }), [mergedNodes, topologyActivity, reducedMotion]);

  const activeEdges = useMemo(
    () => applyHotPotatoEdges(mergedEdges, topologyActivity.packets, { reducedMotion }),
    [mergedEdges, topologyActivity.packets, reducedMotion],
  );
  const layoutSignature = useMemo(() => mergedNodes.map((node) => {
    const style = node.style as { width?: string | number; height?: string | number } | undefined;
    return [
      node.id,
      Math.round(node.position.x),
      Math.round(node.position.y),
      style?.width ?? "",
      style?.height ?? "",
      node.parentId ?? "",
    ].join(":");
  }).join("|"), [mergedNodes]);

  // P5.2-7 click handlers: agent -> seat URL; pod group -> pod URL;
  // softwareTeam group -> toggle (handled inside SoftwareTeamGroupNode onClick; this
  // handler is a no-op for softwareTeamGroup type to avoid double-fire).
  const onNodeClick: NodeMouseHandler = (_evt, node) => {
    const data = node.data as { softwareTeamId?: string; logicalId?: string; podId?: string | null; podNamespace?: string | null } | undefined;
    const softwareTeamId = data?.softwareTeamId;
    if (!softwareTeamId) return;
    if (node.type === "softwareTeamGroup") return; // body click handled by SoftwareTeamGroupNode
    if (node.type === "podGroup" || node.type === "group") {
      const podName = data?.podNamespace ?? data?.podId;
      if (!podName) return;
      navigate({
        to: "/topology/pod/$softwareTeamId/$podName",
        params: { softwareTeamId, podName },
      });
      return;
    }
    if (data?.logicalId) {
      navigate({
        to: "/topology/seat/$softwareTeamId/$logicalId",
        params: { softwareTeamId, logicalId: encodeURIComponent(data.logicalId) },
      });
    }
  };

  if (softwareTeamList.length === 0) {
    return (
      <div
        data-testid="host-multi-software-team-graph-empty"
        className="flex flex-col items-center justify-center h-full font-mono text-[10px] text-on-surface-variant"
      >
        No softwareTeams registered. Run <code className="ml-1 text-on-surface">SoftwareTeam up</code> to start one.
      </div>
    );
  }

  return (
    <div
      data-testid="host-multi-software-team-graph"
      className="w-full h-full relative"
    >
      <ReactFlow
        nodes={activeNodes}
        edges={activeEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodeClick={onNodeClick}
        nodesDraggable={false}
        fitView
        fitViewOptions={{ padding: HOST_GRAPH_FIT_PADDING, includeHiddenNodes: false }}
        minZoom={HOST_GRAPH_MIN_ZOOM}
        maxZoom={HOST_GRAPH_MAX_ZOOM}
        proOptions={{ hideAttribution: true }}
      >
        <HostGraphAutoFit layoutSignature={layoutSignature} />
        <Panel position="top-right" className="!m-3">
          <div className="flex items-center gap-1 border border-outline-variant bg-background/80 px-1.5 py-1 shadow-[2px_2px_0_rgba(46,52,46,0.10)] backdrop-blur-sm">
            <button
              type="button"
              data-testid="topology-expand-all-softwareTeams"
              onClick={expandAllSoftwareTeams}
              disabled={expandedCount === softwareTeamList.length}
              title="Expand all softwareTeams"
              className="inline-flex h-7 items-center gap-1 border border-transparent px-2 font-mono text-[9px] uppercase tracking-[0.08em] text-on-surface hover:border-outline-variant hover:bg-surface-lowest/70 hover:text-on-surface disabled:pointer-events-none disabled:opacity-35"
            >
              <Maximize2 className="h-3.5 w-3.5" aria-hidden="true" />
              Expand all
            </button>
            <button
              type="button"
              data-testid="topology-collapse-all-softwareTeams"
              onClick={collapseAllSoftwareTeams}
              disabled={expandedCount === 0}
              title="Collapse all softwareTeams"
              className="inline-flex h-7 items-center gap-1 border border-transparent px-2 font-mono text-[9px] uppercase tracking-[0.08em] text-on-surface hover:border-outline-variant hover:bg-surface-lowest/70 hover:text-on-surface disabled:pointer-events-none disabled:opacity-35"
            >
              <Minimize2 className="h-3.5 w-3.5" aria-hidden="true" />
              Collapse all
            </button>
          </div>
        </Panel>
        <Controls
          position="bottom-right"
          showInteractive={false}
          className="!bg-surface-lowest/40 !border !border-outline-variant"
        />
      </ReactFlow>
    </div>
  );
}

function HostGraphAutoFit({ layoutSignature }: { layoutSignature: string }) {
  const { fitView } = useReactFlow();
  const nodesInitialized = useNodesInitialized();
  const lastSignatureRef = useRef<string | null>(null);

  useEffect(() => {
    // OPR.0.4.2.17 — gate fitView on nodesInitialized (xyflow has MEASURED the
    // nodes), not a fixed 50ms timeout. On the 30s refetch the nodes re-measure;
    // the old 50ms fired before re-measurement and faithfully fit a
    // collapsed/unmeasured layout. When measurement completes nodesInitialized
    // flips true and this effect re-runs, fitting the real (distinct) layout.
    if (!layoutSignature || !nodesInitialized) return;
    if (lastSignatureRef.current === layoutSignature) return;
    lastSignatureRef.current = layoutSignature;
    void fitView({
      padding: HOST_GRAPH_FIT_PADDING,
      includeHiddenNodes: false,
      duration: 250,
    });
  }, [fitView, layoutSignature, nodesInitialized]);

  return null;
}
