import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp-server.js";
import { DaemonClient, type DaemonResponse } from "../src/client.js";

function mockClient(overrides?: {
  get?: (path: string) => Promise<DaemonResponse>;
  post?: (path: string, body?: unknown, options?: { timeoutMs?: number }) => Promise<DaemonResponse>;
  postText?: (path: string, text: string, contentType?: string, extraHeaders?: Record<string, string>) => Promise<DaemonResponse>;
}): DaemonClient {
  const client = new DaemonClient("http://127.0.0.1:9999");
  client.get = overrides?.get ?? vi.fn(async () => ({ status: 200, data: { status: "ok" } }));
  client.post = overrides?.post ?? vi.fn(async () => ({ status: 200, data: { status: "ok" } }));
  client.postText = overrides?.postText ?? vi.fn(async () => ({ status: 200, data: { valid: true, errors: [] } }));
  return client;
}

describe("MCP Server", () => {
  let mcpClient: Client;
  let daemonClient: DaemonClient;
  let cleanup: () => Promise<void>;

  async function setup(clientOverrides?: Parameters<typeof mockClient>[0]) {
    daemonClient = mockClient(clientOverrides);
    const server = createMcpServer(daemonClient);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    mcpClient = new Client({ name: "test-client", version: "1.0.0" });

    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);

    cleanup = async () => {
      await mcpClient.close();
      await server.close();
    };
  }

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  // T1: MCP server lists all 18 tools
  it("lists all 18 tools", async () => {
    await setup();
    const result = await mcpClient.listTools();
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "softwareteam_add",
      "softwareteam_agent_validate",
      "softwareteam_bind",
      "softwareteam_bundle_inspect",
      "softwareteam_capture",
      "softwareteam_chatroom_send",
      "softwareteam_chatroom_watch",
      "softwareteam_discover",
      "softwareteam_down",
      "softwareteam_ps",
      "softwareteam_restore",
      "softwareteam_software_team_nodes",
      "softwareteam_software_team_validate",
      "softwareteam_send",
      "softwareteam_snapshot_create",
      "softwareteam_snapshot_list",
      "softwareteam_status",
      "softwareteam_up",
    ].sort());
    await cleanup();
  });

  // softwareteam_add: posts the member fragment to the pod-members route.
  it("softwareteam_add posts to the pod-members route and returns the added node", async () => {
    const postFn = vi.fn(async () => ({
      status: 201,
      data: {
        ok: true,
        result: {
          podId: "pod-1",
          podNamespace: "infra",
          node: { logicalId: "infra.server2", nodeId: "n2", status: "launched", sessionName: "infra-server2@r" },
          warnings: [],
        },
      },
    }));
    await setup({ post: postFn });

    const member = { id: "server2", runtime: "terminal", agent_ref: "builtin:terminal", profile: "none", cwd: "/tmp" };
    const result = await mcpClient.callTool({
      name: "softwareteam_add",
      arguments: { softwareTeamId: "software-team-1", podNamespace: "infra", member },
    });

    expect(postFn).toHaveBeenCalledWith("/api/software-teams/software-team-1/pods/infra/members", { member });
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.result.node.logicalId).toBe("infra.server2");
    expect(result.isError).toBeFalsy();
    await cleanup();
  });

  it("softwareteam_add forwards optional pod-local edges in the request body", async () => {
    const postFn = vi.fn(async () => ({
      status: 201,
      data: { ok: true, result: { podId: "pod-1", podNamespace: "infra", node: { logicalId: "infra.server2", nodeId: "n2", status: "launched" }, edges: [{ from: "infra.server2", to: "infra.server", kind: "delegates_to" }] } },
    }));
    await setup({ post: postFn });

    const member = { id: "server2", runtime: "terminal", agent_ref: "builtin:terminal", profile: "none", cwd: "/tmp" };
    const edges = [{ from: "server2", to: "server", kind: "delegates_to" }];
    await mcpClient.callTool({ name: "softwareteam_add", arguments: { softwareTeamId: "software-team-1", podNamespace: "infra", member, edges } });

    expect(postFn).toHaveBeenCalledWith("/api/software-teams/software-team-1/pods/infra/members", { member, edges });
    await cleanup();
  });

  it("softwareteam_add surfaces a member_conflict (HTTP 409) as isError", async () => {
    const postFn = vi.fn(async () => ({
      status: 409,
      data: { ok: false, code: "member_conflict", message: 'Member "infra.server" already exists' },
    }));
    await setup({ post: postFn });

    const result = await mcpClient.callTool({
      name: "softwareteam_add",
      arguments: { softwareTeamId: "software-team-1", podNamespace: "infra", member: { id: "server" } },
    });

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(JSON.parse(content[0].text).code).toBe("member_conflict");
    await cleanup();
  });

  it("softwareteam_add flags a persisted-but-not-launched node as isError", async () => {
    const postFn = vi.fn(async () => ({
      status: 201,
      data: {
        ok: true,
        result: {
          podId: "pod-1",
          podNamespace: "infra",
          node: { logicalId: "infra.server2", nodeId: "n2", status: "failed", error: "harness launch failed" },
        },
      },
    }));
    await setup({ post: postFn });

    const result = await mcpClient.callTool({
      name: "softwareteam_add",
      arguments: { softwareTeamId: "software-team-1", podNamespace: "infra", member: { id: "server2" } },
    });

    expect(result.isError).toBe(true);
    await cleanup();
  });

  // T2: softwareteam_up calls POST /api/up
  it("softwareteam_up calls POST /api/up with correct params", async () => {
    const postFn = vi.fn(async () => ({
      status: 201,
      data: { runId: "run-1", status: "completed", softwareTeamId: "software-team-1", stages: [], errors: [] },
    }));
    await setup({ post: postFn });

    const result = await mcpClient.callTool({
      name: "softwareteam_up",
      arguments: { sourceRef: "/tmp/software-team.yaml", plan: false, autoApprove: true },
    });

    expect(postFn).toHaveBeenCalledWith(
      "/api/up",
      {
        sourceRef: "/tmp/software-team.yaml",
        plan: false,
        autoApprove: true,
        targetRoot: undefined,
      },
      { timeoutMs: 120_000 },
    );
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0].text);
    expect(parsed.status).toBe("completed");
    expect(result.isError).toBeFalsy();
    await cleanup();
  });

  // T3: softwareteam_down calls POST /api/down
  it("softwareteam_down calls POST /api/down with correct params", async () => {
    const postFn = vi.fn(async () => ({
      status: 200,
      data: { softwareTeamId: "software-team-1", sessionsKilled: 2, deleted: false, deleteBlocked: false, alreadyStopped: false, errors: [] },
    }));
    await setup({ post: postFn });

    const result = await mcpClient.callTool({
      name: "softwareteam_down",
      arguments: { softwareTeamId: "software-team-1", delete: true, force: false, snapshot: false },
    });

    expect(postFn).toHaveBeenCalledWith("/api/down", {
      softwareTeamId: "software-team-1",
      delete: true,
      force: false,
      snapshot: false,
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0].text);
    expect(parsed.sessionsKilled).toBe(2);
    expect(result.isError).toBeFalsy();
    await cleanup();
  });

  // T4: softwareteam_ps calls GET /api/ps
  it("softwareteam_ps calls GET /api/ps and returns entries", async () => {
    const getFn = vi.fn(async () => ({
      status: 200,
      data: [{ softwareTeamId: "software-team-1", name: "test", nodeCount: 2, runningCount: 2, status: "running", uptime: "1h", latestSnapshot: null }],
    }));
    await setup({ get: getFn });

    const result = await mcpClient.callTool({ name: "softwareteam_ps", arguments: {} });

    expect(getFn).toHaveBeenCalledWith("/api/ps");
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0].text);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].softwareTeamId).toBe("software-team-1");
    expect(result.isError).toBeFalsy();
    await cleanup();
  });

  // T5: Tool schemas have required properties
  it("tool schemas have correct required properties", async () => {
    await setup();
    const result = await mcpClient.listTools();

    const upTool = result.tools.find((t) => t.name === "softwareteam_up")!;
    expect(upTool.inputSchema.required).toContain("sourceRef");
    expect(upTool.inputSchema.properties).toHaveProperty("plan");
    expect(upTool.inputSchema.properties).toHaveProperty("autoApprove");

    const downTool = result.tools.find((t) => t.name === "softwareteam_down")!;
    expect(downTool.inputSchema.required).toContain("softwareTeamId");

    const restoreTool = result.tools.find((t) => t.name === "softwareteam_restore")!;
    expect(restoreTool.inputSchema.required).toContain("softwareTeamId");
    expect(restoreTool.inputSchema.required).toContain("snapshotId");

    await cleanup();
  });

  // T6: HTTP 404 -> isError:true
  it("HTTP error maps to isError:true", async () => {
    const postFn = vi.fn(async () => ({
      status: 404,
      data: { error: "SoftwareTeam not found" },
    }));
    await setup({ post: postFn });

    const result = await mcpClient.callTool({
      name: "softwareteam_down",
      arguments: { softwareTeamId: "missing" },
    });

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0].text);
    expect(parsed.error).toBe("SoftwareTeam not found");
    await cleanup();
  });

  // T7: In-body errors -> isError:true
  it("in-body errors map to isError:true", async () => {
    const postFn = vi.fn(async () => ({
      status: 200,
      data: { softwareTeamId: "software-team-1", sessionsKilled: 1, deleted: false, deleteBlocked: false, alreadyStopped: false, errors: ["Kill failed"] },
    }));
    await setup({ post: postFn });

    const result = await mcpClient.callTool({
      name: "softwareteam_down",
      arguments: { softwareTeamId: "software-team-1" },
    });

    expect(result.isError).toBe(true);
    await cleanup();
  });

  // T8: Transport connect/disconnect lifecycle
  it("transport connects and disconnects cleanly", async () => {
    await setup();

    // Verify server is responsive
    const result = await mcpClient.listTools();
    expect(result.tools.length).toBe(18);

    // Clean disconnect
    await cleanup();

    // Create a fresh pair to verify we can reconnect
    daemonClient = mockClient();
    const server2 = createMcpServer(daemonClient);
    const [ct2, st2] = InMemoryTransport.createLinkedPair();
    const client2 = new Client({ name: "test-client-2", version: "1.0.0" });
    await server2.connect(st2);
    await client2.connect(ct2);

    const result2 = await client2.listTools();
    expect(result2.tools.length).toBe(18);

    await client2.close();
    await server2.close();
  });

  // T9: bundle inspect integrityResult.passed=false -> isError:true
  it("bundle inspect integrity failure maps to isError:true", async () => {
    const postFn = vi.fn(async () => ({
      status: 200,
      data: {
        manifest: { name: "test", version: "1.0.0", packages: [] },
        digestValid: true,
        integrityResult: { passed: false, mismatches: ["pkg-a"], missing: [], extra: [], errors: [] },
      },
    }));
    await setup({ post: postFn });

    const result = await mcpClient.callTool({
      name: "softwareteam_bundle_inspect",
      arguments: { bundlePath: "/tmp/test.softwareteambundle" },
    });

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0].text);
    expect(parsed.integrityResult.passed).toBe(false);
    await cleanup();
  });

  // T10: MCP server lists softwareteam_agent_validate + softwareteam_software_team_validate tools
  it("softwareteam_agent_validate and softwareteam_software_team_validate tools are registered", async () => {
    await setup();
    const result = await mcpClient.listTools();
    const names = result.tools.map((t) => t.name);
    expect(names).toContain("softwareteam_agent_validate");
    expect(names).toContain("softwareteam_software_team_validate");

    // Verify schema: both have required "yaml" input
    const agentTool = result.tools.find((t) => t.name === "softwareteam_agent_validate")!;
    expect(agentTool.inputSchema.required).toContain("yaml");
    const softwareTeamTool = result.tools.find((t) => t.name === "softwareteam_software_team_validate")!;
    expect(softwareTeamTool.inputSchema.required).toContain("yaml");

    await cleanup();
  });

  // T10b: softwareteam_agent_validate calls postText with correct path
  it("softwareteam_agent_validate calls postText on /api/agents/validate", async () => {
    const postTextFn = vi.fn(async () => ({
      status: 200,
      data: { valid: true, errors: [] },
    }));
    await setup({ postText: postTextFn });

    const result = await mcpClient.callTool({
      name: "softwareteam_agent_validate",
      arguments: { yaml: "name: my-agent\nversion: 1.0.0\n" },
    });

    expect(postTextFn).toHaveBeenCalledWith("/api/agents/validate", "name: my-agent\nversion: 1.0.0\n");
    expect(result.isError).toBeFalsy();
    await cleanup();
  });

  // T11: MCP tools URL-encode path parameters
  it("snapshot_create URL-encodes softwareTeamId in path", async () => {
    const postFn = vi.fn(async () => ({
      status: 201,
      data: { id: "snap-1", softwareTeamId: "softwareTeam/with/slashes", kind: "manual", status: "complete" },
    }));
    await setup({ post: postFn });

    await mcpClient.callTool({
      name: "softwareteam_snapshot_create",
      arguments: { softwareTeamId: "softwareTeam/with/slashes" },
    });

    const calledPath = postFn.mock.calls[0][0] as string;
    expect(calledPath).toBe(`/api/software-teams/${encodeURIComponent("softwareTeam/with/slashes")}/snapshots`);
    expect(calledPath).toContain("softwareTeam%2Fwith%2Fslashes");
    await cleanup();
  });

  // NS-T09: softwareteam_software_team_nodes calls GET /api/software-teams/:softwareTeamId/nodes
  it("softwareteam_software_team_nodes returns node inventory", async () => {
    const getFn = vi.fn(async (path: string) => {
      if (path.includes("/nodes")) {
        return {
          status: 200,
          data: [
            { softwareTeamId: "software-team-1", softwareTeamName: "test", logicalId: "dev.impl", nodeKind: "agent", runtime: "claude-code", sessionStatus: "running", tmuxAttachCommand: "tmux attach -t dev-impl@test" },
          ],
        };
      }
      return { status: 200, data: {} };
    });
    await setup({ get: getFn });

    const result = await mcpClient.callTool({
      name: "softwareteam_software_team_nodes",
      arguments: { softwareTeamId: "software-team-1" },
    });

    expect(getFn).toHaveBeenCalled();
    const calledPath = getFn.mock.calls.find((c) => (c[0] as string).includes("/nodes"))?.[0] as string;
    expect(calledPath).toBe("/api/software-teams/software-team-1/nodes");
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].nodeKind).toBe("agent");
    await cleanup();
  });

  // T14: softwareteam_send returns structured result
  it("softwareteam_send returns structured result", async () => {
    const postFn = vi.fn(async () => ({
      status: 200,
      data: { ok: true, sessionName: "dev-impl@my-software-team" },
    }));
    await setup({ post: postFn });

    const result = await mcpClient.callTool({
      name: "softwareteam_send",
      arguments: { session: "dev-impl@my-software-team", text: "hello" },
    });

    expect(postFn).toHaveBeenCalled();
    expect(postFn.mock.calls[0]?.[2]).toBeUndefined();
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
    expect(parsed.ok).toBe(true);
    expect(parsed.sessionName).toBe("dev-impl@my-software-team");
    await cleanup();
  });

  it("softwareteam_send with waitForIdleSeconds extends request timeout", async () => {
    const postFn = vi.fn(async () => ({
      status: 200,
      data: { ok: true, sessionName: "dev-impl@my-software-team" },
    }));
    await setup({ post: postFn });

    const result = await mcpClient.callTool({
      name: "softwareteam_send",
      arguments: { session: "dev-impl@my-software-team", text: "hello", waitForIdleSeconds: 30 },
    });

    expect(postFn).toHaveBeenCalledWith(
      "/api/transport/send",
      expect.objectContaining({
        session: "dev-impl@my-software-team",
        text: "hello",
        waitForIdleMs: 30000,
      }),
      { timeoutMs: 35000 },
    );
    expect(result.isError).toBeUndefined();
    await cleanup();
  });

  it("softwareteam_send rejects waitForIdleSeconds with force before daemon contact", async () => {
    const postFn = vi.fn(async () => ({
      status: 200,
      data: { ok: true },
    }));
    await setup({ post: postFn });

    const result = await mcpClient.callTool({
      name: "softwareteam_send",
      arguments: { session: "dev-impl@my-software-team", text: "hello", waitForIdleSeconds: 30, force: true },
    });

    expect(result.isError).toBe(true);
    expect(postFn).not.toHaveBeenCalled();
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
    expect(parsed.error).toContain("cannot be combined");
    await cleanup();
  });

  // T-chatroom-send: softwareteam_chatroom_send returns result
  it("softwareteam_chatroom_send returns result", async () => {
    const getFn = vi.fn(async () => ({
      status: 200,
      data: [{ id: "software-team-1", name: "my-software-team", nodeCount: 2 }],
    }));
    const postFn = vi.fn(async () => ({
      status: 201,
      data: { id: "msg-1", softwareTeamId: "software-team-1", sender: "mcp", kind: "message", body: "hello", topic: null, createdAt: "2026-03-31T10:00:00Z" },
    }));
    await setup({ get: getFn, post: postFn });

    const result = await mcpClient.callTool({
      name: "softwareteam_chatroom_send",
      arguments: { softwareTeamName: "my-software-team", body: "hello" },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
    expect(parsed.sender).toBe("mcp");
    expect(parsed.body).toBe("hello");
    await cleanup();
  });

  // T-chatroom-watch: softwareteam_chatroom_watch returns recent history
  it("softwareteam_chatroom_watch returns recent history", async () => {
    const getFn = vi.fn(async (path: string) => {
      if (path === "/api/software-teams/summary") {
        return {
          status: 200,
          data: [{ id: "software-team-1", name: "my-software-team", nodeCount: 2 }],
        };
      }
      if (path.includes("/chat/history")) {
        return {
          status: 200,
          data: [
            { id: "msg-1", softwareTeamId: "software-team-1", sender: "alice", kind: "message", body: "hello", topic: null, createdAt: "2026-03-31T10:00:00Z" },
          ],
        };
      }
      return { status: 200, data: {} };
    });
    await setup({ get: getFn });

    const result = await mcpClient.callTool({
      name: "softwareteam_chatroom_watch",
      arguments: { softwareTeamName: "my-software-team" },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].sender).toBe("alice");
    await cleanup();
  });

  // T-chatroom-ambiguous: MCP softwareteam_chatroom_send with ambiguous softwareTeam name -> error
  it("softwareteam_chatroom_send with ambiguous SoftwareTeam name returns error", async () => {
    const getFn = vi.fn(async () => ({
      status: 200,
      data: [
        { id: "software-team-1", name: "my-software-team", nodeCount: 2 },
        { id: "software-team-2", name: "my-software-team", nodeCount: 1 },
      ],
    }));
    await setup({ get: getFn });

    const result = await mcpClient.callTool({
      name: "softwareteam_chatroom_send",
      arguments: { softwareTeamName: "my-software-team", body: "hello" },
    });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
    expect(parsed.error).toContain("ambiguous");
    await cleanup();
  });

  // T15: softwareteam_capture returns structured result
  it("softwareteam_capture returns structured result", async () => {
    const postFn = vi.fn(async () => ({
      status: 200,
      data: { ok: true, sessionName: "dev-impl@my-software-team", content: "pane output", lines: 20 },
    }));
    await setup({ post: postFn });

    const result = await mcpClient.callTool({
      name: "softwareteam_capture",
      arguments: { session: "dev-impl@my-software-team" },
    });

    expect(postFn).toHaveBeenCalled();
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
    expect(parsed.ok).toBe(true);
    expect(parsed.content).toBe("pane output");
    await cleanup();
  });
});
