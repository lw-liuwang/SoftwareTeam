import type Database from "better-sqlite3";
import type { SoftwareTeamRepository } from "./software-team-repository.js";
import type { PodRepository } from "./pod-repository.js";
import type { SessionRegistry } from "./session-registry.js";
import type { EventBus } from "./event-bus.js";
import type { PersistedEvent } from "./types.js";
import type { TmuxAdapter } from "../adapters/tmux.js";
import type { TranscriptStore } from "./transcript-store.js";
import { startTmuxTranscriptCapture } from "./transcript-capture.js";

export type SelfAttachSuccess = {
  ok: true;
  nodeId: string;
  logicalId: string;
  sessionId: string;
  sessionName: string;
  attachmentType: "tmux" | "external_cli";
  env: {
    SOFTWARETEAM_NODE_ID: string;
    SOFTWARETEAM_SESSION_NAME: string;
    // OPR.0.4.3.28 B3 — activity env echoed for the caller's shell to export.
    SOFTWARETEAM_RUNTIME?: string;
    SOFTWARETEAM_URL?: string;
    SOFTWARETEAM_ACTIVITY_HOOK_TOKEN?: string;
  };
};

export type SelfAttachFailureCode =
  | "software_team_not_found"
  | "node_not_found"
  | "pod_not_found"
  | "already_bound"
  | "duplicate_logical_id"
  | "invalid_member_name"
  | "runtime_required"
  | "runtime_mismatch";

export type SelfAttachResult =
  | SelfAttachSuccess
  | { ok: false; code: SelfAttachFailureCode; error: string };

interface SelfAttachServiceDeps {
  db: Database.Database;
  softwareTeamRepo: SoftwareTeamRepository;
  podRepo: PodRepository;
  sessionRegistry: SessionRegistry;
  eventBus: EventBus;
  tmuxAdapter?: TmuxAdapter;
  transcriptStore?: TranscriptStore;
  claudeContextProvisioner?: {
    ensureContextCollector(binding: { cwd?: string | null; tmuxSession?: string | null }): void;
  };
  // OPR.0.4.3.28 B3 — the daemon's resolved activity url+token, echoed into the
  // self-attach RESPONSE env so the caller's shell (and any agent it starts)
  // can reach the ingest endpoint. This is a returned env for the caller to
  // export — NOT a mutation of an already-running process.
  activityEnv?: { url?: string; token?: string };
}

interface AttachToNodeOptions {
  softwareTeamId: string;
  logicalId: string;
  runtime?: string;
  cwd?: string;
  displayName?: string;
  context?: SelfAttachContext;
}

interface AttachToPodOptions {
  softwareTeamId: string;
  podNamespace: string;
  memberName: string;
  runtime: string;
  cwd?: string;
  displayName?: string;
  context?: SelfAttachContext;
}

interface ExternalCliAttachContext {
  attachmentType: "external_cli";
  sessionName?: string;
}

interface TmuxAttachContext {
  attachmentType: "tmux";
  tmuxSession: string;
  tmuxWindow?: string;
  tmuxPane?: string;
}

export type SelfAttachContext = ExternalCliAttachContext | TmuxAttachContext;

export class SelfAttachService {
  readonly db: Database.Database;
  private softwareTeamRepo: SoftwareTeamRepository;
  private podRepo: PodRepository;
  private sessionRegistry: SessionRegistry;
  private eventBus: EventBus;
  private tmuxAdapter: TmuxAdapter | null;
  private transcriptStore: TranscriptStore | null;
  private claudeContextProvisioner: SelfAttachServiceDeps["claudeContextProvisioner"] | null;
  private activityEnv: { url?: string; token?: string };

  constructor(deps: SelfAttachServiceDeps) {
    if (deps.db !== deps.softwareTeamRepo.db) throw new Error("SelfAttachService: softwareTeamRepo must share the same db handle");
    if (deps.db !== deps.podRepo.db) throw new Error("SelfAttachService: podRepo must share the same db handle");
    if (deps.db !== deps.sessionRegistry.db) throw new Error("SelfAttachService: sessionRegistry must share the same db handle");
    if (deps.db !== deps.eventBus.db) throw new Error("SelfAttachService: eventBus must share the same db handle");
    this.db = deps.db;
    this.softwareTeamRepo = deps.softwareTeamRepo;
    this.podRepo = deps.podRepo;
    this.sessionRegistry = deps.sessionRegistry;
    this.eventBus = deps.eventBus;
    this.tmuxAdapter = deps.tmuxAdapter ?? null;
    this.transcriptStore = deps.transcriptStore ?? null;
    this.activityEnv = deps.activityEnv ?? {};
    this.claudeContextProvisioner = deps.claudeContextProvisioner ?? null;
  }

  async attachToNode(opts: AttachToNodeOptions): Promise<SelfAttachResult> {
    const softwareTeam = this.softwareTeamRepo.getSoftwareTeam(opts.softwareTeamId);
    if (!softwareTeam) {
      return { ok: false, code: "software_team_not_found", error: "Target SoftwareTeam not found" };
    }

    const node = softwareTeam.nodes.find((candidate) => candidate.logicalId === opts.logicalId);
    if (!node) {
      return { ok: false, code: "node_not_found", error: `Logical ID '${opts.logicalId}' does not exist in softwareTeam` };
    }

    const existingBinding = this.sessionRegistry.getBindingForNode(node.id);
    if (existingBinding) {
      return { ok: false, code: "already_bound", error: `Logical ID '${opts.logicalId}' is already bound` };
    }

    if (opts.runtime && node.runtime && opts.runtime !== node.runtime) {
      return {
        ok: false,
        code: "runtime_mismatch",
        error: `Logical ID '${opts.logicalId}' expects runtime '${node.runtime}', but attach-self declared '${opts.runtime}'`,
      };
    }

    return this.attachExistingNode({
      softwareTeamId: opts.softwareTeamId,
      softwareTeamName: softwareTeam.softwareTeam.name,
      nodeId: node.id,
      logicalId: node.logicalId,
      runtime: node.runtime ?? opts.runtime,
      cwd: node.cwd ?? opts.cwd,
      context: this.resolveContext(node.logicalId, softwareTeam.softwareTeam.name, opts.displayName, opts.context),
    });
  }

  async attachToPod(opts: AttachToPodOptions): Promise<SelfAttachResult> {
    const softwareTeam = this.softwareTeamRepo.getSoftwareTeam(opts.softwareTeamId);
    if (!softwareTeam) {
      return { ok: false, code: "software_team_not_found", error: "Target SoftwareTeam not found" };
    }

    const pod = this.podRepo.getPodByNamespace(opts.softwareTeamId, opts.podNamespace);
    if (!pod) {
      return { ok: false, code: "pod_not_found", error: `Pod namespace '${opts.podNamespace}' not found in softwareTeam` };
    }

    const memberName = opts.memberName.trim();
    if (!memberName) {
      return { ok: false, code: "invalid_member_name", error: "memberName is required" };
    }

    const runtime = opts.runtime.trim();
    if (!runtime) {
      return { ok: false, code: "runtime_required", error: "runtime is required when creating a new pod member" };
    }

    const logicalId = `${pod.namespace}.${memberName}`;
    if (softwareTeam.nodes.some((candidate) => candidate.logicalId === logicalId)) {
      return { ok: false, code: "duplicate_logical_id", error: `Logical ID '${logicalId}' already exists in softwareTeam` };
    }

    const attachTx = this.db.transaction(() => {
      const node = this.softwareTeamRepo.addNode(opts.softwareTeamId, logicalId, {
        runtime,
        cwd: opts.cwd,
        podId: pod.id,
      });
      const attached = this.attachExistingNodeWithinTransaction({
        softwareTeamId: opts.softwareTeamId,
        nodeId: node.id,
        logicalId,
        context: this.resolveContext(logicalId, softwareTeam.softwareTeam.name, opts.displayName, opts.context),
      });
      return attached;
    });

    try {
      const result = attachTx();
      this.maybeProvisionContextCollector(opts.runtime, opts.cwd, result.sessionName, result.attachmentType);
      await this.maybeStartTranscriptCapture(softwareTeam.softwareTeam.name, result.sessionName, result.attachmentType);
      this.eventBus.notifySubscribers(result.event);
      return this.toSuccess(result.nodeId, result.logicalId, result.sessionId, result.sessionName, result.attachmentType, runtime);
    } catch (error) {
      return { ok: false, code: "duplicate_logical_id", error: (error as Error).message };
    }
  }

  private async attachExistingNode(args: {
    softwareTeamId: string;
    softwareTeamName: string;
    nodeId: string;
    logicalId: string;
    runtime?: string | null;
    cwd?: string | null;
    context: SelfAttachContext;
  }): Promise<SelfAttachResult> {
    const attachTx = this.db.transaction(() =>
      this.attachExistingNodeWithinTransaction({
        softwareTeamId: args.softwareTeamId,
        nodeId: args.nodeId,
        logicalId: args.logicalId,
        context: args.context,
      })
    );

    try {
      const result = attachTx();
      return this.finalizeAttach(args.softwareTeamName, result, args.runtime, args.cwd);
    } catch (error) {
      return { ok: false, code: "already_bound", error: (error as Error).message };
    }
  }

  private async finalizeAttach(
    softwareTeamName: string,
    result: {
      nodeId: string;
      logicalId: string;
      sessionId: string;
      sessionName: string;
      attachmentType: "tmux" | "external_cli";
      event: PersistedEvent;
    },
    runtime?: string | null,
    cwd?: string | null,
  ): Promise<SelfAttachResult> {
    try {
      this.maybeProvisionContextCollector(runtime, cwd, result.sessionName, result.attachmentType);
      await this.maybeStartTranscriptCapture(softwareTeamName, result.sessionName, result.attachmentType);
      this.eventBus.notifySubscribers(result.event);
      return this.toSuccess(result.nodeId, result.logicalId, result.sessionId, result.sessionName, result.attachmentType, runtime);
    } catch (error) {
      return { ok: false, code: "already_bound", error: (error as Error).message };
    }
  }

  private attachExistingNodeWithinTransaction(args: {
    softwareTeamId: string;
    nodeId: string;
    logicalId: string;
    context: SelfAttachContext;
  }): {
    nodeId: string;
    logicalId: string;
    sessionId: string;
    sessionName: string;
    attachmentType: "tmux" | "external_cli";
    event: PersistedEvent;
  } {
    const sessionName = args.context.attachmentType === "tmux"
      ? args.context.tmuxSession
      : args.context.sessionName ?? `unknown-${args.nodeId.slice(-6)}`;

    this.sessionRegistry.updateBinding(args.nodeId, args.context.attachmentType === "tmux"
      ? {
          attachmentType: "tmux",
          tmuxSession: args.context.tmuxSession,
          tmuxWindow: args.context.tmuxWindow,
          tmuxPane: args.context.tmuxPane,
        }
      : {
          attachmentType: "external_cli",
          externalSessionName: sessionName,
        });
    const session = this.sessionRegistry.registerClaimedSession(args.nodeId, sessionName);
    const event = this.eventBus.persistWithinTransaction({
      type: "binding.updated",
      softwareTeamId: args.softwareTeamId,
      nodeId: args.nodeId,
    });

    return {
      nodeId: args.nodeId,
      logicalId: args.logicalId,
      sessionId: session.id,
      sessionName,
      attachmentType: args.context.attachmentType,
      event,
    };
  }

  private resolveContext(
    logicalId: string,
    softwareTeamName: string,
    displayName?: string,
    context?: SelfAttachContext,
  ): SelfAttachContext {
    if (context?.attachmentType === "tmux") {
      return context;
    }
    const explicit = context?.attachmentType === "external_cli" ? context.sessionName?.trim() : displayName?.trim();
    return {
      attachmentType: "external_cli",
      sessionName: explicit || `${logicalId.replace(/\./g, "-")}@${softwareTeamName}`,
    };
  }

  private async maybeStartTranscriptCapture(
    softwareTeamName: string,
    sessionName: string,
    attachmentType: "tmux" | "external_cli",
  ): Promise<void> {
    if (attachmentType !== "tmux") return;
    await startTmuxTranscriptCapture(this.tmuxAdapter, this.transcriptStore, softwareTeamName, sessionName);
  }

  private maybeProvisionContextCollector(
    runtime: string | null | undefined,
    cwd: string | null | undefined,
    sessionName: string,
    attachmentType: "tmux" | "external_cli",
  ): void {
    if (attachmentType !== "tmux" || runtime !== "claude-code") return;
    try {
      this.claudeContextProvisioner?.ensureContextCollector({
        cwd: cwd ?? undefined,
        tmuxSession: sessionName,
      });
    } catch { /* best-effort */ }
  }

  private toSuccess(
    nodeId: string,
    logicalId: string,
    sessionId: string,
    sessionName: string,
    attachmentType: "tmux" | "external_cli",
    runtime?: string | null,
  ): SelfAttachSuccess {
    // OPR.0.4.3.28 B3 — echo the activity env so the caller's shell (and any
    // agent it starts) produces activity signal: SOFTWARETEAM_RUNTIME is required by
    // the relay to build a payload; url+token let it reach the ingest endpoint
    // directly (file-discovery is the fallback when they are absent).
    const env: SelfAttachSuccess["env"] = {
      SOFTWARETEAM_NODE_ID: nodeId,
      SOFTWARETEAM_SESSION_NAME: sessionName,
    };
    if (runtime) env.SOFTWARETEAM_RUNTIME = runtime;
    if (this.activityEnv.url) env.SOFTWARETEAM_URL = this.activityEnv.url;
    if (this.activityEnv.token) env.SOFTWARETEAM_ACTIVITY_HOOK_TOKEN = this.activityEnv.token;
    return {
      ok: true,
      nodeId,
      logicalId,
      sessionId,
      sessionName,
      attachmentType,
      env,
    };
  }
}
