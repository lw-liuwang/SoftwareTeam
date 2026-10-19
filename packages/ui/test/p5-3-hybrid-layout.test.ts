import { describe, expect, it } from "vitest";
import {
  HYBRID_COLLAPSED_SOFTWARE_TEAM_HEIGHT,
  HYBRID_COLLAPSED_SOFTWARE_TEAM_WIDTH,
  HYBRID_CROSS_SOFTWARE_TEAM_STROKE_DASH,
  getHybridEdgeStyle,
  layoutHybridOuterSoftwareTeams,
  layoutHybridSoftwareTeam,
  prefixedHybridNodeId,
  unprefixedHybridNodeId,
} from "../src/lib/hybrid-layout.js";

describe("P5.3 hybrid layout helpers", () => {
  it("prefixes node IDs with softwareTeamId and can parse them back", () => {
    const id = prefixedHybridNodeId("software-team-1", "agent-a");
    expect(id).toBe("software-team-1::agent-a");
    expect(unprefixedHybridNodeId(id)).toEqual({ softwareTeamId: "software-team-1", localId: "agent-a" });
    expect(unprefixedHybridNodeId("agent-a")).toEqual({ softwareTeamId: null, localId: "agent-a" });
  });

  it("lays out expanded SoftwareTeam as nested SoftwareTeam -> pod -> agent nodes", () => {
    const layout = layoutHybridSoftwareTeam({
      softwareTeamId: "software-team-1",
      collapsed: false,
      nodes: [
        { id: "pod-dev", type: "podGroup", position: { x: 0, y: 0 }, data: { podNamespace: "dev" } },
        { id: "dev.driver", type: "softwareTeamNode", parentId: "pod-dev", position: { x: 0, y: 0 }, data: { logicalId: "dev.driver" } },
        { id: "dev.guard", type: "softwareTeamNode", parentId: "pod-dev", position: { x: 0, y: 0 }, data: { logicalId: "dev.guard" } },
      ],
      edges: [
        { id: "e1", source: "dev.driver", target: "dev.guard" },
      ],
    });

    expect(layout.width).toBeGreaterThan(HYBRID_COLLAPSED_SOFTWARE_TEAM_WIDTH);
    expect(layout.height).toBeGreaterThanOrEqual(HYBRID_COLLAPSED_SOFTWARE_TEAM_HEIGHT);
    expect(layout.podCount).toBe(1);

    const pod = layout.nodes.find((node) => node.id === "software-team-1::pod-dev");
    const agent = layout.nodes.find((node) => node.id === "software-team-1::dev.driver");
    expect(pod?.parentId).toBe("software-team-software-team-1");
    expect(agent?.parentId).toBe("software-team-1::pod-dev");
    expect(layout.edges[0]?.source).toBe("software-team-1::dev.driver");
    expect(layout.edges[0]?.target).toBe("software-team-1::dev.guard");
  });

  it("keeps collapsed softwareTeams cheap: no child graph and fixed card dimensions", () => {
    const layout = layoutHybridSoftwareTeam({
      softwareTeamId: "software-team-1",
      collapsed: true,
      nodes: [
        { id: "pod-dev", type: "podGroup", position: { x: 0, y: 0 }, data: { podNamespace: "dev" } },
      ],
      edges: [],
    });

    expect(layout.nodes).toHaveLength(0);
    expect(layout.edges).toHaveLength(0);
    expect(layout.width).toBe(HYBRID_COLLAPSED_SOFTWARE_TEAM_WIDTH);
    expect(layout.height).toBe(HYBRID_COLLAPSED_SOFTWARE_TEAM_HEIGHT);
  });

  it("outer dagre layout gives each SoftwareTeam frame a stable canvas position", () => {
    const positions = layoutHybridOuterSoftwareTeams([
      { softwareTeamId: "software-team-1", width: 300, height: 120 },
      { softwareTeamId: "software-team-2", width: 320, height: 160 },
      { softwareTeamId: "software-team-3", width: 280, height: 140 },
      { softwareTeamId: "software-team-4", width: 360, height: 180 },
    ]);

    expect(positions).toHaveLength(4);
    expect(new Set(positions.map((softwareTeam) => `${softwareTeam.position.x}:${softwareTeam.position.y}`)).size).toBe(4);
  });

  it("shares the cross-software-team dashed style constant", () => {
    const style = getHybridEdgeStyle("handoff", true);
    expect(style?.strokeDasharray).toBe(HYBRID_CROSS_SOFTWARE_TEAM_STROKE_DASH);
  });
});
