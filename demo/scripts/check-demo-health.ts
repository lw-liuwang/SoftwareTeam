import {
  getCurrentSoftwareTeamSummary,
  listSoftwareTeamNodes,
  parseArgs,
  isAgentRuntime,
} from "./common.js";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const softwareTeam = String(args["softwareTeam"] ?? args["software-team-id"] ?? "demo-software-team");
  const json = args["json"] === true;

  const softwareTeamSummary = getCurrentSoftwareTeamSummary(softwareTeam);
  const nodes = listSoftwareTeamNodes(softwareTeam);

  const summary = {
    softwareTeam,
    softwareTeamId: softwareTeamSummary?.softwareTeamId ?? null,
    status: softwareTeamSummary?.status ?? null,
    exists: Boolean(softwareTeamSummary),
    nodeCount: nodes.length,
    agentCount: nodes.filter((node) => isAgentRuntime(node.runtime)).length,
    startupReady: nodes.filter((node) => node.startupStatus === "ready").map((node) => node.logicalId),
    startupPending: nodes.filter((node) => node.startupStatus !== "ready").map((node) => ({
      logicalId: node.logicalId,
      startupStatus: node.startupStatus,
      restoreOutcome: node.restoreOutcome,
      latestError: node.latestError ?? null,
    })),
    resumeMetadata: nodes
      .filter((node) => isAgentRuntime(node.runtime))
      .map((node) => ({
        logicalId: node.logicalId,
        runtime: node.runtime,
        resumeType: node.resumeType ?? null,
        hasResumeToken: Boolean(node.resumeToken),
      })),
  };

  if (json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`Demo health: ${softwareTeam}`);
    if (summary.softwareTeamId) {
      console.log(`- softwareTeamId: ${summary.softwareTeamId}`);
    }
    if (summary.status) {
      console.log(`- status: ${summary.status}`);
    }
    console.log(`- exists: ${summary.exists ? "yes" : "no"}`);
    console.log(`- nodes: ${summary.nodeCount}`);
    console.log(`- ready: ${summary.startupReady.length}`);
    if (summary.startupPending.length > 0) {
      console.log("- pending/failed:");
      for (const item of summary.startupPending) {
        console.log(
          `  ${item.logicalId}: startup=${item.startupStatus ?? "n/a"} restore=${item.restoreOutcome ?? "n/a"}`
        );
        if (item.latestError) {
          console.log(`    error: ${item.latestError}`);
        }
      }
    }
    console.log("- resume metadata:");
    for (const item of summary.resumeMetadata) {
      console.log(
        `  ${item.logicalId} [${item.runtime}] type=${item.resumeType ?? "none"} token=${item.hasResumeToken ? "yes" : "no"}`
      );
    }
  }

  if (!summary.exists || summary.nodeCount === 0) {
    process.exitCode = 1;
  }
}

await main();
