// V1 polish slice Phase 5.2 P5.2-3 + P5.2-6 — multi-softwareTeam canvas helpers.
//
// Two responsibilities:
//   1. prefixSoftwareTeamData(softwareTeamId, nodes, edges): cross-softwareTeam node-ID prefixing
//      so the merged canvas satisfies react-flow's unique-ID requirement.
//      Each prefixed node carries `data.softwareTeamId` so downstream click
//      handlers read softwareTeamId from `node.data.softwareTeamId` (NOT closure).
//   2. packSoftwareTeamGroups(softwareTeamBounds, viewportWidth): outer offset packing.
//      Per-softwareTeam layout already happened via applyTreeLayout (or fixed
//      collapsed-card dimensions when not yet expanded); this helper
//      places each softwareTeam group at a grid offset in the host canvas.
//
// Layout strategy = option (a) per-softwareTeam + outer offset (per Phase 5.2
// ACK §2). Rationale: collapse stability — toggling softwareTeam N doesn't
// reflow softwareTeams 1..N-1 because each softwareTeam's internal layout is independent
// and its outer offset is fixed by its grid slot.

const PREFIX_DELIMITER = "::";

export const COLLAPSED_SOFTWARE_TEAM_WIDTH = 280;
export const COLLAPSED_SOFTWARE_TEAM_HEIGHT = 120;
const SOFTWARE_TEAM_GUTTER_X = 48;
const SOFTWARE_TEAM_GUTTER_Y = 48;
/** Extra height the softwareTeam group adds above its expanded children
 *  (header + counts strip + padding). Used by expanded-bounds calc. */
export const SOFTWARE_TEAM_HEADER_HEIGHT = 60;
export const SOFTWARE_TEAM_PADDING = 16;

/** Prefix every node ID + edge endpoint with `${softwareTeamId}::` so the merged
 *  multi-softwareTeam graph has globally-unique IDs. Threads `data.softwareTeamId` onto
 *  every node so click handlers can read it without closure capture. */
export function prefixSoftwareTeamData<
  N extends { id: string; data?: Record<string, unknown> },
  E extends { id: string; source: string; target: string },
>(
  softwareTeamId: string,
  nodes: readonly N[],
  edges: readonly E[],
): { nodes: N[]; edges: E[] } {
  const prefixed = (id: string) => `${softwareTeamId}${PREFIX_DELIMITER}${id}`;
  return {
    nodes: nodes.map((n) => ({
      ...n,
      id: prefixed(n.id),
      // Some node shapes carry parentId for react-flow parent/child;
      // prefix that too if present.
      ...((n as unknown as { parentId?: string }).parentId
        ? { parentId: prefixed((n as unknown as { parentId: string }).parentId) }
        : {}),
      data: { ...(n.data ?? {}), softwareTeamId },
    })),
    edges: edges.map((e) => ({
      ...e,
      id: prefixed(e.id),
      source: prefixed(e.source),
      target: prefixed(e.target),
    })),
  };
}

/** Compute the bounding box of a set of laid-out nodes (per-softwareTeam
 *  expanded children) so the outer softwareTeam group can size correctly.
 *  Returns software-team-internal-relative coordinates (the top-left node at
 *  origin); the outer offset is added by packSoftwareTeamGroups. */
export function computeBounds(
  nodes: ReadonlyArray<{ position: { x: number; y: number }; initialWidth?: number; initialHeight?: number }>,
): { width: number; height: number; minX: number; minY: number } {
  if (nodes.length === 0) {
    return { width: COLLAPSED_SOFTWARE_TEAM_WIDTH, height: COLLAPSED_SOFTWARE_TEAM_HEIGHT, minX: 0, minY: 0 };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    const w = n.initialWidth ?? 240;
    const h = n.initialHeight ?? 160;
    minX = Math.min(minX, n.position.x);
    minY = Math.min(minY, n.position.y);
    maxX = Math.max(maxX, n.position.x + w);
    maxY = Math.max(maxY, n.position.y + h);
  }
  return {
    width: Math.max(maxX - minX + 2 * SOFTWARE_TEAM_PADDING, COLLAPSED_SOFTWARE_TEAM_WIDTH),
    height: maxY - minY + 2 * SOFTWARE_TEAM_PADDING + SOFTWARE_TEAM_HEADER_HEIGHT,
    minX,
    minY,
  };
}

export interface SoftwareTeamBounds {
  softwareTeamId: string;
  width: number;
  height: number;
}

export interface PackedSoftwareTeam {
  softwareTeamId: string;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
}

/** Pack softwareTeam groups in a grid given a viewport width. Each softwareTeam keeps its
 *  own (possibly-different-sized) bounds; the grid uses a max-width
 *  column tracker per row so wider softwareTeams don't squeeze narrower ones.
 *  Simple greedy row-fill — sufficient for V1 fleet sizes. */
export function packSoftwareTeamGroups(
  softwareTeams: readonly SoftwareTeamBounds[],
  viewportWidth: number,
): PackedSoftwareTeam[] {
  const packed: PackedSoftwareTeam[] = [];
  const minViewport = Math.max(viewportWidth, COLLAPSED_SOFTWARE_TEAM_WIDTH + 2 * SOFTWARE_TEAM_GUTTER_X);
  let cursorX = 0;
  let cursorY = 0;
  let rowMaxHeight = 0;
  for (const softwareTeam of softwareTeams) {
    if (cursorX + softwareTeam.width > minViewport && cursorX > 0) {
      // Wrap to next row.
      cursorX = 0;
      cursorY += rowMaxHeight + SOFTWARE_TEAM_GUTTER_Y;
      rowMaxHeight = 0;
    }
    packed.push({
      softwareTeamId: softwareTeam.softwareTeamId,
      offsetX: cursorX,
      offsetY: cursorY,
      width: softwareTeam.width,
      height: softwareTeam.height,
    });
    cursorX += softwareTeam.width + SOFTWARE_TEAM_GUTTER_X;
    rowMaxHeight = Math.max(rowMaxHeight, softwareTeam.height);
  }
  return packed;
}
