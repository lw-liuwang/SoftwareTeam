import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { formatDaemonHostForUrl } from "../client.js";

export interface StartupProofDeps {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  readFile?: (path: string) => string;
}

export interface StartupProofSubmitResult {
  ok: true;
  oriented: "verified";
  nodeId: string;
  challengeId: string;
}

interface Endpoint {
  baseUrl: string;
  token: string;
}

function first(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

export function resolveStartupProofEndpoint(deps: StartupProofDeps = {}): Endpoint | null {
  const env = deps.env ?? process.env;
  const readFile = deps.readFile ?? ((p: string) => fs.readFileSync(p, "utf8"));
  const home = first(env["SOFTWARETEAM_HOME"], env["SOFTWARETEAM_HOME"]) ?? path.join(os.homedir(), ".softwareteam");
  let baseUrl = first(env["SOFTWARETEAM_URL"], env["SOFTWARETEAM_URL"]);
  let token = first(env["SOFTWARETEAM_ACTIVITY_HOOK_TOKEN"], env["SOFTWARETEAM_ACTIVITY_HOOK_TOKEN"]);

  if (!baseUrl || !token) {
    try {
      const endpoint = JSON.parse(readFile(path.join(home, "activity-endpoint.json"))) as Record<string, unknown>;
      baseUrl ??= first(endpoint["baseUrl"]);
      token ??= first(endpoint["token"]);
    } catch {
      // File discovery is best-effort; env and host/port fallback may still work.
    }
  }

  if (!baseUrl) {
    const port = first(env["SOFTWARETEAM_PORT"], env["SOFTWARETEAM_PORT"]);
    if (port) baseUrl = `http://${formatDaemonHostForUrl(first(env["SOFTWARETEAM_HOST"], env["SOFTWARETEAM_HOST"]) ?? "127.0.0.1")}:${port}`;
  }

  return baseUrl && token ? { baseUrl, token } : null;
}

export async function submitStartupProof(
  input: { challengeId: string; answer: string },
  deps: StartupProofDeps = {},
): Promise<StartupProofSubmitResult> {
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const endpoint = resolveStartupProofEndpoint(deps);
  if (!endpoint) {
    throw new Error("SoftwareTeam startup proof endpoint is unavailable");
  }

  const res = await fetchImpl(new URL("/api/activity/hooks", endpoint.baseUrl).toString(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${endpoint.token}`,
    },
    body: JSON.stringify({
      eventFamily: "startup_proof",
      sessionName: first(env["SOFTWARETEAM_SESSION_NAME"], env["SOFTWARETEAM_SESSION_NAME"]),
      nodeId: first(env["SOFTWARETEAM_NODE_ID"], env["SOFTWARETEAM_NODE_ID"]),
      runtime: first(env["SOFTWARETEAM_RUNTIME"], env["SOFTWARETEAM_RUNTIME"]),
      challengeId: input.challengeId,
      answer: input.answer,
    }),
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { ok: false, error: text };
  }
  if (!res.ok) {
    const message = typeof parsed === "object" && parsed && "error" in parsed
      ? String((parsed as { error?: unknown }).error)
      : text;
    throw new Error(`startup_proof rejected: ${res.status} ${message}`);
  }
  return parsed as StartupProofSubmitResult;
}

export function startupProofCommand(depsOverride?: StartupProofDeps): Command {
  const cmd = new Command("startup-proof")
    .description("Submit and inspect startup orientation proof");

  cmd.command("submit")
    .description("Submit this seat's startup proof through the authenticated SoftwareTeam activity hook")
    .requiredOption("--challenge-id <id>", "Startup challenge id from the startup prompt")
    .requiredOption("--answer <answer>", "Expected answer from the startup prompt")
    .option("--json", "Print raw JSON response")
    .action(async (opts: { challengeId: string; answer: string; json?: boolean }) => {
      try {
        const result = await submitStartupProof({ challengeId: opts.challengeId, answer: opts.answer }, depsOverride);
        if (opts.json) {
          console.log(JSON.stringify(result));
        } else {
          console.log(`startup_proof: ${result.oriented}`);
          console.log(`node_id: ${result.nodeId}`);
          console.log(`challenge_id: ${result.challengeId}`);
        }
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });

  return cmd;
}
