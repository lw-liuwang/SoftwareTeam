import { DaemonClient, DaemonConnectionError, DaemonTimeoutError, remoteDaemonClient } from "./client.js";
import { loadHostRegistry, resolveHost, resolveRemoteBearer, bearerAuthHeaders, classifyHttpFailedStep, classifyHttpError, type HttpHostEntry } from "./host-registry.js";
import { resolveOriginSelfHostId, type LifecycleDeps } from "./daemon-lifecycle.js";
import type { FailedStep } from "./cross-host-types.js";

export interface RemoteHostDeps {
  clientFactory: (url: string) => DaemonClient;
  hostRegistryLoader?: () => ReturnType<typeof loadHostRegistry>;
  /**
   * A4: present ⇒ `runRemoteHttpOp` resolves THIS host's `selfHostId` (fail-open) and stamps the origin
   * TRIPLE on the remote request so the remote daemon renders the ORIGIN host. Absent (some test mocks)
   * ⇒ the 2-part header stamps, fail-open — no new failure mode. The 8 command modules that call this
   * pass their command deps (which carry `lifecycleDeps`), so the production remote path stamps the triple.
   */
  lifecycleDeps?: LifecycleDeps;
}

export interface RemoteOpResult {
  ok: boolean;
  failedStep: FailedStep;
  data?: unknown;
  error?: string;
  /** The request may have reached the remote and been acted on, but no usable answer came back: a timeout, a
   *  connection reset or dropped mid-request, or an unreadable response. Unset when the connection provably
   *  never reached the remote. A caller whose request writes must not read such a failure as "not done". */
  outcomeUnknown?: true;
}

// Connection failures that prove the request never reached the remote daemon. Codes the kernel can also report on a
// socket that already sent the request (route loss, an interface going down, a firewall change mid-flow: EHOSTUNREACH,
// ENETUNREACH, EHOSTDOWN, ENETDOWN, EPERM, EACCES) are left out, so they read as an unknown outcome.
const NOT_CONNECTED_CODES = new Set([
  "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EADDRNOTAVAIL", "UND_ERR_CONNECT_TIMEOUT", "ERR_INVALID_URL",
]);

function requestMayHaveArrived(err: unknown): boolean {
  if (err instanceof DaemonTimeoutError) return true;
  if (err instanceof DaemonConnectionError) return err.causeCode === undefined || !NOT_CONNECTED_CODES.has(err.causeCode);
  return true;
}

export async function runRemoteHttpOp(
  hostId: string,
  method: "GET" | "POST",
  apiPath: string,
  body: unknown | undefined,
  deps: RemoteHostDeps,
  // OPR.0.4.6.MH4 — optional per-call deadline (additive; absent = the
  // DaemonClient default). Every remote call site names its own budget.
  opts: { json?: boolean; timeoutMs?: number },
): Promise<RemoteOpResult> {
  const loader = deps.hostRegistryLoader ?? loadHostRegistry;
  const registry = loader();
  if (!registry.ok) {
    return { ok: false, failedStep: "remote-daemon-unreachable", error: registry.error };
  }
  const resolved = resolveHost(registry.registry, hostId);
  if (!resolved.ok) {
    return { ok: false, failedStep: "remote-daemon-unreachable", error: resolved.error };
  }
  const host = resolved.host;

  if (host.transport === "ssh") {
    return { ok: false, failedStep: "remote-command-failed", error: `host ${hostId} uses SSH transport; HTTP --host not available` };
  }

  const httpHost = host as HttpHostEntry;
  const bearerResult = resolveRemoteBearer(httpHost);
  if (!bearerResult.ok) {
    return { ok: false, failedStep: bearerResult.failedStep, error: bearerResult.error };
  }

  // A4: the SINGLE remote-origin construction for the 8 modules that route through this chokepoint —
  // stamp the origin triple (fail-open to 2-part when the local selfHostId is unavailable / no lifecycleDeps).
  const originSelfHostId = deps.lifecycleDeps ? await resolveOriginSelfHostId(deps.lifecycleDeps) : undefined;
  const client = remoteDaemonClient(deps.clientFactory, httpHost.url, originSelfHostId);
  const headers = bearerAuthHeaders(bearerResult.token);
  const requestOptions = opts.timeoutMs !== undefined ? { headers, timeoutMs: opts.timeoutMs } : { headers };

  try {
    const res = method === "POST"
      ? await client.post<unknown>(apiPath, body, requestOptions)
      : await client.get<unknown>(apiPath, requestOptions);

    const failedStep = classifyHttpFailedStep(res.status);
    if (failedStep !== "none") {
      // Carry the origin response body on failures too (additive): the
      // remote route's own error text is the honest detail a caller
      // surfaces beside the step class.
      return { ok: false, failedStep, error: `HTTP ${res.status}`, data: res.data };
    }
    return { ok: true, failedStep: "none", data: res.data };
  } catch (err) {
    return {
      ok: false,
      failedStep: classifyHttpError(err),
      error: (err as Error).message,
      ...(requestMayHaveArrived(err) ? { outcomeUnknown: true as const } : {}),
    };
  }
}

/** How a softwareTeam handle matched a host's softwareTeam list: an exact id first (archived softwareTeams included), else one active softwareTeam of
 *  that name. Non-object rows (null, primitives) take no part, so they can't hide or block a match. A row without a
 *  string `softwareTeamId` can't be a target, but an active one still counts toward a name's ambiguity, and a name only it
 *  carries is not found. `unavailable` means the list itself couldn't be read or wasn't a list, so nothing is known. */
export type RemoteSoftwareTeamLookup =
  | { kind: "resolved"; softwareTeamId: string; byName: boolean }
  /** `count` is every active row with that name; `ids` the ones that can be targeted. */
  | { kind: "ambiguous"; count: number; ids: string[] }
  | { kind: "not_found" }
  | { kind: "unavailable"; error: string | undefined };

export async function lookupRemoteSoftwareTeamId(hostId: string, handle: string, deps: RemoteHostDeps): Promise<RemoteSoftwareTeamLookup> {
  const psResult = await runRemoteHttpOp(hostId, "GET", "/api/ps?includeArchived=true", undefined, deps, {});
  if (!psResult.ok) return { kind: "unavailable", error: psResult.error };
  if (!Array.isArray(psResult.data)) return { kind: "unavailable", error: "the host's SoftwareTeam list was not readable" };
  const rows = (psResult.data as unknown[]).filter(
    (r): r is { softwareTeamId?: unknown; name?: unknown; archivedAt?: string | null } => r !== null && typeof r === "object",
  );
  const targetable = (r: { softwareTeamId?: unknown }): r is { softwareTeamId: string } => typeof r.softwareTeamId === "string";

  const exactId = rows.find((r) => targetable(r) && r.softwareTeamId === handle);
  if (exactId && targetable(exactId)) return { kind: "resolved", softwareTeamId: exactId.softwareTeamId, byName: false };

  const byName = rows.filter((r) => r.name === handle && !r.archivedAt);
  if (byName.length > 1) return { kind: "ambiguous", count: byName.length, ids: byName.filter(targetable).map((r) => r.softwareTeamId) };
  const only = byName[0];
  if (only && targetable(only)) return { kind: "resolved", softwareTeamId: only.softwareTeamId, byName: true };
  return { kind: "not_found" };
}

export async function resolveRemoteSoftwareTeamId(
  hostId: string,
  handle: string,
  deps: RemoteHostDeps,
): Promise<{ ok: true; softwareTeamId: string } | { ok: false; error: string }> {
  const lookup = await lookupRemoteSoftwareTeamId(hostId, handle, deps);
  switch (lookup.kind) {
    case "resolved": return { ok: true, softwareTeamId: lookup.softwareTeamId };
    case "unavailable": return { ok: false, error: `cannot resolve SoftwareTeam on host ${hostId}: ${lookup.error}` };
    case "ambiguous":
      return { ok: false, error: `ambiguous SoftwareTeam name "${handle}" on host ${hostId}: ${lookup.count} active softwareTeams share that name. Use the SoftwareTeam id instead.` };
    case "not_found": return { ok: false, error: `softwareTeam "${handle}" not found on host ${hostId}` };
  }
}
