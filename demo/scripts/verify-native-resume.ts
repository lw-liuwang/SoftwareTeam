import { listSoftwareTeamNodes, parseArgs, writeJson, isAgentRuntime } from "./common.js";
import { probeNodeResume } from "./resume-probe-lib.js";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const softwareTeam = String(args["softwareTeam"] ?? args["software-team-id"] ?? "demo-software-team");
  const logicalIdFilter = typeof args["logical-id"] === "string" ? String(args["logical-id"]) : null;
  const json = args["json"] === true;
  const output = typeof args["output"] === "string" ? String(args["output"]) : null;

  const nodes = listSoftwareTeamNodes(softwareTeam)
    .filter((node) => isAgentRuntime(node.runtime))
    .filter((node) => !logicalIdFilter || node.logicalId === logicalIdFilter);

  if (nodes.length === 0) {
    console.error(`No agent nodes found for softwareTeam '${softwareTeam}'.`);
    process.exitCode = 1;
    return;
  }

  const results = [];
  for (const node of nodes) {
    results.push(await probeNodeResume(node));
  }

  const summary = {
    softwareTeam,
    ok: results.every((result) => result.status === "resumed"),
    results,
  };

  if (output) {
    writeJson(output, summary);
  }

  if (json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`Native resume probe: ${softwareTeam}`);
    for (const result of results) {
      console.log(
        `- ${result.logicalId} [${result.runtime}] ${result.status}: ${result.detail}`
      );
      if (result.command) {
        console.log(`  command: ${result.command}`);
      }
      if (result.paneCommand) {
        console.log(`  pane: ${result.paneCommand}`);
      }
    }
  }

  if (!summary.ok) {
    process.exitCode = 1;
  }
}

await main();
