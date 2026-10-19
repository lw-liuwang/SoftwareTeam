export {
  ensureSoftwareTeamInstance,
  formatInstanceInitializationConflicts,
  type SoftwareTeamInstanceInitializationOptions,
  type SoftwareTeamInstanceInitializationResult,
} from "./domain/instance-initialization.js";
export {
  ensureDefaultWorkspace,
  nodeInitializationFs,
  workspaceScaffoldDirs,
  workspaceScaffoldFiles,
  type InitializationConflict,
  type InitializationFsOps,
  type InitWorkspaceResult,
  type ManagedPathKind,
} from "./domain/workspace/default-workspace-scaffold.js";
