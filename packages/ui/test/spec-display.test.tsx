import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { SoftwareTeamSpecDisplay } from "../src/components/SoftwareTeamSpecDisplay.js";
import { AgentSpecDisplay } from "../src/components/AgentSpecDisplay.js";
import { DrawerSelectionContext, type DrawerSelection } from "../src/components/AppShell.js";
import type { SoftwareTeamSpecReview, AgentSpecReview } from "../src/hooks/useSpecReview.js";

afterEach(() => cleanup());

const POD_AWARE_REVIEW: SoftwareTeamSpecReview = {
  sourceState: "draft",
  kind: "softwareTeam",
  name: "test-software-team",
  version: "0.2",
  summary: "A test softwareTeam",
  format: "pod_aware",
  pods: [
    {
      id: "dev",
      label: "Development",
      members: [
        { id: "impl", agentRef: "local:agents/impl", runtime: "claude-code", profile: "default" },
        { id: "qa", agentRef: "local:agents/qa", runtime: "codex" },
      ],
      edges: [{ from: "impl", to: "qa", kind: "delegates_to" }],
    },
  ],
  edges: [{ from: "dev.impl", to: "orch.lead", kind: "reports_to" }],
  graph: { nodes: [], edges: [] },
  raw: "name: test-software-team",
};

const LEGACY_REVIEW: SoftwareTeamSpecReview = {
  sourceState: "draft",
  kind: "softwareTeam",
  name: "legacy-software-team",
  version: "0.1",
  format: "legacy",
  nodes: [
    { id: "node-1", runtime: "claude-code", role: "lead" },
    { id: "node-2", runtime: "codex", role: "worker" },
  ],
  edges: [{ from: "node-1", to: "node-2", kind: "delegates_to" }],
  graph: { nodes: [], edges: [] },
  raw: "name: legacy-software-team",
};

const AGENT_REVIEW: AgentSpecReview = {
  sourceState: "draft",
  kind: "agent",
  name: "test-agent",
  version: "1.0.0",
  description: "A test agent",
  profiles: [
    { name: "default", description: "Default profile" },
    { name: "review", description: "Review mode" },
  ],
  resources: {
    skills: ["tdd", "debugging"],
    guidance: ["code-style.md"],
    plugins: ["softwareteam-core"],
    subagents: [],
  },
  startup: {
    files: [
      { path: "CLAUDE.md", required: true },
      { path: "optional.md", required: false },
    ],
    actions: [
      { type: "slash_command", value: "/compact" },
    ],
  },
  raw: "name: test-agent",
};

describe("SoftwareTeamSpecDisplay", () => {
  it("renders pod member tables for pod-aware review data", () => {
    render(<SoftwareTeamSpecDisplay review={POD_AWARE_REVIEW} yaml="name: test" />);

    // Switch to configuration tab
    fireEvent.click(screen.getByTestId("tab-configuration"));

    expect(screen.getByTestId("config-tables")).toBeDefined();
    expect(screen.getByText("Development")).toBeDefined();
    expect(screen.getByText("impl")).toBeDefined();
    expect(screen.getByText("qa")).toBeDefined();
    expect(screen.getByText("local:agents/impl")).toBeDefined();
    expect(screen.getByRole("img", { name: "Claude" })).toBeDefined();
    expect(screen.getByRole("img", { name: "Codex" })).toBeDefined();
  });

  it("renders legacy node tables for legacy review data", () => {
    render(<SoftwareTeamSpecDisplay review={LEGACY_REVIEW} yaml="name: test" />);

    fireEvent.click(screen.getByTestId("tab-configuration"));

    expect(screen.getByText("Nodes")).toBeDefined();
    expect(screen.getAllByText("node-1").length).toBeGreaterThan(0);
    expect(screen.getAllByText("node-2").length).toBeGreaterThan(0);
    expect(screen.getByText("lead")).toBeDefined();
    expect(screen.getByRole("img", { name: "Claude" })).toBeDefined();
    expect(screen.getByRole("img", { name: "Codex" })).toBeDefined();
  });

  it("renders edge table", () => {
    render(<SoftwareTeamSpecDisplay review={LEGACY_REVIEW} yaml="name: test" />);

    fireEvent.click(screen.getByTestId("tab-configuration"));

    expect(screen.getByText("Edges")).toBeDefined();
    expect(screen.getByText("delegates_to")).toBeDefined();
  });

  it("calls onMemberClick handler when member button is clicked", () => {
    const clicks: Array<{ podId: string; memberId: string }> = [];

    render(
      <SoftwareTeamSpecDisplay
        review={POD_AWARE_REVIEW}
        yaml="name: test"
        onMemberClick={(podId, member) => clicks.push({ podId, memberId: member.id })}
      />,
    );

    fireEvent.click(screen.getByTestId("tab-configuration"));
    fireEvent.click(screen.getByTestId("member-open-agent-dev-impl"));

    expect(clicks).toHaveLength(1);
    expect(clicks[0]).toEqual({ podId: "dev", memberId: "impl" });
  });

  it("renders YAML tab content", () => {
    render(<SoftwareTeamSpecDisplay review={POD_AWARE_REVIEW} yaml="name: my-software-team\npods: []" />);

    fireEvent.click(screen.getByTestId("tab-yaml"));

    expect(screen.getByTestId("spec-yaml").textContent).toContain("name: my-software-team");
  });

  it("renders tabs even without review data", () => {
    render(<SoftwareTeamSpecDisplay yaml="name: pending" />);

    expect(screen.getByTestId("tab-topology")).toBeDefined();
    expect(screen.getByTestId("tab-configuration")).toBeDefined();
    expect(screen.getByTestId("tab-yaml")).toBeDefined();
  });
});

describe("AgentSpecDisplay", () => {
  it("renders profiles section", () => {
    render(<AgentSpecDisplay review={AGENT_REVIEW} yaml="name: test" />);

    expect(screen.getByTestId("agent-profiles-section")).toBeDefined();
    expect(screen.getByText("default")).toBeDefined();
    expect(screen.getByText("review")).toBeDefined();
  });

  it("renders resources section with skill badges", () => {
    render(<AgentSpecDisplay review={AGENT_REVIEW} yaml="name: test" />);

    expect(screen.getByTestId("agent-resources-section")).toBeDefined();
    expect(screen.getByText("tdd")).toBeDefined();
    expect(screen.getByText("debugging")).toBeDefined();
    expect(screen.getByText("code-style.md")).toBeDefined();
  });

  it("wraps guidance resources in file triggers when sourcePath is available", () => {
    const setSelection = vi.fn();
    render(
      <DrawerSelectionContext.Provider value={{ selection: null, setSelection: setSelection as (sel: DrawerSelection) => void }}>
        <AgentSpecDisplay
          review={AGENT_REVIEW}
          yaml="name: test"
          sourcePath="/workspace/specs/agents/test-agent/agent.yaml"
        />
      </DrawerSelectionContext.Provider>,
    );

    fireEvent.click(screen.getByTestId("agent-guidance-file-trigger-code-style.md"));
    expect(setSelection).toHaveBeenCalledWith({
      type: "file",
      data: {
        path: "code-style.md",
        absolutePath: "/workspace/specs/agents/test-agent/code-style.md",
      },
    });
  });

  it("renders startup section with files and actions", () => {
    render(<AgentSpecDisplay review={AGENT_REVIEW} yaml="name: test" />);

    expect(screen.getByTestId("agent-startup-section")).toBeDefined();
    expect(screen.getByText("CLAUDE.md")).toBeDefined();
    expect(screen.getByText("REQUIRED")).toBeDefined();
    expect(screen.getByText("/compact")).toBeDefined();
  });

  it("renders YAML section", () => {
    render(<AgentSpecDisplay review={AGENT_REVIEW} yaml="name: my-agent\nversion: 1.0" />);

    expect(screen.getByTestId("agent-spec-yaml").textContent).toContain("name: my-agent");
  });

  it("renders with custom testIdPrefix", () => {
    render(<AgentSpecDisplay review={AGENT_REVIEW} yaml="name: test" testIdPrefix="lib-agent" />);

    expect(screen.getByTestId("lib-agent-profiles-section")).toBeDefined();
    expect(screen.getByTestId("lib-agent-resources-section")).toBeDefined();
    expect(screen.getByTestId("lib-agent-startup-section")).toBeDefined();
    expect(screen.getByTestId("lib-agent-spec-yaml")).toBeDefined();
  });
});
