import type {
  ActionRetryPolicy,
  ModelGateway,
  WorkspaceCommandExecutor,
  WorkspaceFileAccessProvider,
  WorkspaceFileSystem,
  WorkspaceRecord
} from "../types.js";
import { AppError } from "../errors.js";

export const PUBLIC_NATIVE_TOOL_NAMES = [
  "Bash",
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "WebFetch",
  "TodoWrite",
  "TerminalOutput",
  "TerminalInput",
  "TerminalStop"
] as const;

export const NATIVE_TOOL_NAMES = [...PUBLIC_NATIVE_TOOL_NAMES] as const;

export type NativeToolName = (typeof NATIVE_TOOL_NAMES)[number];

const NATIVE_TOOL_RETRY_POLICY: Record<NativeToolName, ActionRetryPolicy> = {
  Bash: "manual",
  Read: "safe",
  Write: "manual",
  Edit: "manual",
  Glob: "safe",
  Grep: "safe",
  WebFetch: "safe",
  TodoWrite: "manual",
  TerminalOutput: "safe",
  TerminalInput: "manual",
  TerminalStop: "manual"
};

export interface NativeToolSetOptions {
  sessionId?: string | undefined;
  modelGateway?: ModelGateway | undefined;
  webFetchModel?: string | undefined;
  commandExecutor?: WorkspaceCommandExecutor | undefined;
  fileSystem?: WorkspaceFileSystem | undefined;
  workspace?: WorkspaceRecord | undefined;
  workspaceFileAccessProvider?: WorkspaceFileAccessProvider | undefined;
  readVirtualFile?: ((input: { filePath: string; abortSignal?: AbortSignal | undefined }) => Promise<{
    filePath: string;
    content: string;
  } | null>) | undefined;
}

export interface NativeToolFileAccess {
  workspaceRoot: string;
  fileSystem: WorkspaceFileSystem;
  workspace?: WorkspaceRecord | undefined;
}

export interface NativeToolFactoryContext {
  workspaceRoot: string;
  sessionId: string;
  readHistoryPath: string;
  todoPath: string;
  options?: NativeToolSetOptions | undefined;
  commandExecutor: WorkspaceCommandExecutor;
  fileSystem: WorkspaceFileSystem;
  withFileSystem: <T>(
    access: "read" | "write",
    targetPath: string | undefined,
    operation: (input: NativeToolFileAccess) => Promise<T>
  ) => Promise<T>;
  readVirtualFile: (input: { filePath: string; abortSignal?: AbortSignal | undefined }) => Promise<{
    filePath: string;
    content: string;
  } | null>;
  assertVisible: (toolName: NativeToolName) => void;
  omitLegacyKeys: <T extends Record<string, unknown>>(value: T, keys: string[]) => Record<string, unknown>;
  rememberRead: (relativePath: string, workspaceRoot?: string, fileSystem?: WorkspaceFileSystem) => Promise<void>;
  assertReadBeforeMutating: (
    relativePath: string,
    toolName: "Write" | "Edit",
    workspaceRoot?: string,
    fileSystem?: WorkspaceFileSystem
  ) => Promise<void>;
}

function normalizeNativeToolName(toolName: string): NativeToolName | undefined {
  if ((NATIVE_TOOL_NAMES as readonly string[]).includes(toolName)) {
    return toolName as NativeToolName;
  }

  return undefined;
}

export function isNativeToolName(toolName: string): toolName is NativeToolName {
  return normalizeNativeToolName(toolName) !== undefined;
}

export function getNativeToolRetryPolicy(toolName: string): ActionRetryPolicy {
  const normalized = normalizeNativeToolName(toolName);
  if (!normalized) {
    throw new AppError(404, "native_tool_not_found", `Native tool ${toolName} was not found.`);
  }

  return NATIVE_TOOL_RETRY_POLICY[normalized];
}
