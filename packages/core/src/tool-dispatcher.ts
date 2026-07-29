import type { Action, VerificationCommand } from "../../contracts/src/index.js";
import {
  applyApprovedPatch as applyWorkspacePatch,
  getWorkspaceFileHash,
  listWorkspaceFiles,
  readWorkspaceFile,
  runVerification as runConfiguredVerification,
  searchWorkspaceText,
} from "../../tools/src/index.js";
import type {
  ApplyApprovedPatchResult,
  ListWorkspaceFilesResult,
  PatchApproval,
  SearchWorkspaceTextResult,
  VerificationResult,
} from "../../tools/src/index.js";
import {
  MAX_LIST_DEPTH,
  MAX_LIST_ENTRIES,
  MAX_READ_BYTES,
  MAX_SEARCH_RESULTS,
} from "../../tools/src/workspace.js";
import { CodeSentinelCoreError } from "./errors.js";

export interface ToolDispatcher {
  listFiles(action: Extract<Action, { kind: "list_files" }>): Promise<ListWorkspaceFilesResult>;
  readFile(action: Extract<Action, { kind: "read_file" }>): Promise<string>;
  searchText(
    action: Extract<Action, { kind: "search_text" }>,
  ): Promise<SearchWorkspaceTextResult>;
  runVerification(
    action: Extract<Action, { kind: "run_verification" }>,
  ): Promise<VerificationResult>;
  getCurrentBaseHash(path: string): Promise<string>;
  applyApprovedPatch(
    input: Readonly<{ path: string; patch: string; approval: PatchApproval }>,
  ): Promise<ApplyApprovedPatchResult>;
}

export type ToolDispatcherOptions = Readonly<{
  workspaceRoot?: string;
  verificationCommands: readonly VerificationCommand[];
  canReadPath?: (path: string) => boolean;
  listFiles?: ToolDispatcher["listFiles"];
  readFile?: ToolDispatcher["readFile"];
  searchText?: ToolDispatcher["searchText"];
  runVerification?: ToolDispatcher["runVerification"];
  getCurrentBaseHash?: ToolDispatcher["getCurrentBaseHash"];
  applyApprovedPatch?: ToolDispatcher["applyApprovedPatch"];
}>;

type WorkspaceBinding = Readonly<{
  workspaceRoot: string;
  canReadPath: (path: string) => boolean;
}>;

type ListFilesAction = Extract<Action, { kind: "list_files" }>;
type ReadFileAction = Extract<Action, { kind: "read_file" }>;
type SearchTextAction = Extract<Action, { kind: "search_text" }>;
type RunVerificationAction = Extract<Action, { kind: "run_verification" }>;
type ApprovedPatchInput = Readonly<{ path: string; patch: string; approval: PatchApproval }>;

export function createToolDispatcher(options: ToolDispatcherOptions): ToolDispatcher {
  const verificationCommands = copyVerificationCommands(options.verificationCommands);
  const workspace = resolveWorkspaceBinding(options);
  const listFilesOverride = options.listFiles;
  const readFileOverride = options.readFile;
  const searchTextOverride = options.searchText;
  const runVerificationOverride = options.runVerification;
  const getCurrentBaseHashOverride = options.getCurrentBaseHash;
  const applyApprovedPatchOverride = options.applyApprovedPatch;

  return Object.freeze({
    async listFiles(action: ListFilesAction): Promise<ListWorkspaceFilesResult> {
      if (listFilesOverride !== undefined) {
        return listFilesOverride(action);
      }

      const binding = requireWorkspaceBinding(workspace);
      if (action.path !== undefined && action.path.length > 0 && !binding.canReadPath(action.path)) {
        throwUnsupportedTool();
      }
      return listWorkspaceFiles({
        workspaceRoot: binding.workspaceRoot,
        path: action.path,
        depth: action.depth ?? MAX_LIST_DEPTH,
        maxEntries: MAX_LIST_ENTRIES,
        shouldInclude: binding.canReadPath,
      });
    },
    async readFile(action: ReadFileAction): Promise<string> {
      if (readFileOverride !== undefined) {
        return readFileOverride(action);
      }

      const binding = requireReadableWorkspacePath(workspace, action.path);
      return readWorkspaceFile({
        workspaceRoot: binding.workspaceRoot,
        path: action.path,
        maxBytes: MAX_READ_BYTES,
      });
    },
    async searchText(action: SearchTextAction): Promise<SearchWorkspaceTextResult> {
      if (searchTextOverride !== undefined) {
        return searchTextOverride(action);
      }

      const binding = requireWorkspaceBinding(workspace);
      if (action.path !== undefined && !binding.canReadPath(action.path)) {
        throwUnsupportedTool();
      }
      return searchWorkspaceText({
        workspaceRoot: binding.workspaceRoot,
        path: action.path,
        query: action.query,
        maxResults: action.maxResults ?? MAX_SEARCH_RESULTS,
        shouldInclude: binding.canReadPath,
      });
    },
    async runVerification(action: RunVerificationAction): Promise<VerificationResult> {
      const command = verificationCommands.find((candidate) => candidate.id === action.commandId);
      if (command === undefined) {
        throwUnsupportedTool();
      }
      if (runVerificationOverride !== undefined) {
        return runVerificationOverride(action);
      }

      const binding = requireWorkspaceBinding(workspace);
      return runConfiguredVerification({ command, cwd: binding.workspaceRoot });
    },
    async getCurrentBaseHash(path: string): Promise<string> {
      if (getCurrentBaseHashOverride !== undefined) {
        return getCurrentBaseHashOverride(path);
      }

      const binding = requireReadableWorkspacePath(workspace, path);
      return getWorkspaceFileHash({ workspaceRoot: binding.workspaceRoot, path });
    },
    async applyApprovedPatch(input: ApprovedPatchInput): Promise<ApplyApprovedPatchResult> {
      if (applyApprovedPatchOverride !== undefined) {
        return applyApprovedPatchOverride(input);
      }

      const binding = requireReadableWorkspacePath(workspace, input.path);
      return applyWorkspacePatch({ ...input, workspaceRoot: binding.workspaceRoot });
    },
  });
}

function copyVerificationCommands(
  commands: readonly VerificationCommand[],
): readonly VerificationCommand[] {
  return Object.freeze(
    commands.map((command) =>
      Object.freeze({
        id: command.id,
        launcher: command.launcher,
        args: Object.freeze([...command.args]) as VerificationCommand["args"],
        timeoutMs: command.timeoutMs,
        maxOutputBytes: command.maxOutputBytes,
      }),
    ),
  );
}

function resolveWorkspaceBinding(options: ToolDispatcherOptions): WorkspaceBinding | undefined {
  if (
    typeof options.workspaceRoot !== "string" ||
    options.workspaceRoot.trim().length === 0 ||
    options.canReadPath === undefined
  ) {
    return undefined;
  }

  return Object.freeze({
    workspaceRoot: options.workspaceRoot,
    canReadPath: options.canReadPath,
  });
}

function requireWorkspaceBinding(binding: WorkspaceBinding | undefined): WorkspaceBinding {
  if (binding === undefined) {
    throwUnsupportedTool();
  }

  return binding;
}

function requireReadableWorkspacePath(
  workspace: WorkspaceBinding | undefined,
  path: string,
): WorkspaceBinding {
  const binding = requireWorkspaceBinding(workspace);
  if (!binding.canReadPath(path)) {
    throwUnsupportedTool();
  }

  return binding;
}

function throwUnsupportedTool(): never {
  throw new CodeSentinelCoreError("UNSUPPORTED_TOOL");
}
