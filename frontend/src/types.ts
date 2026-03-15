// Frontend-safe type definitions (mirrors src/types.ts without Node.js imports)

export type BatchStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type RunStatus =
  | "queued"
  | "preparing"
  | "waiting_for_codex"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";
export type GenerationStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface BatchConfig {
  runCount: number;
  concurrency: number;
  projectPath: string;
  worktreeRoot: string;
  prompt: string;
  taskPrompt: string;
  baseRef: string;
  model: string;
  sandboxMode: string;
  networkAccessEnabled: boolean;
  webSearchMode: string;
  reasoningEffort: string;
}

export interface GenerationTask {
  title: string;
  prompt: string;
}

export interface GenerationState {
  status: GenerationStatus;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  tasks: GenerationTask[];
}

export interface ProjectContext {
  projectPath: string;
  repoRoot: string;
  relativeProjectPath: string;
  headSha: string;
  branchName: string;
}

export interface RunLog {
  id: string;
  at: string;
  level: string;
  message: string;
}

export interface RunReviewUntrackedFile {
  path: string;
  preview: string;
}

export interface RunReview {
  currentBranch: string | null;
  headSha: string | null;
  statusShort: string;
  diffStat: string;
  trackedDiff: string;
  untrackedFiles: RunReviewUntrackedFile[];
}

export interface RunUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens?: number;
  [key: string]: unknown;
}

export interface RunTurn {
  id: string;
  index: number;
  prompt: string;
  status: RunStatus;
  submittedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  finalResponse: string;
  error: string | null;
  usage: RunUsage | null;
  items: StreamItem[];
}

export interface FileChange {
  path: string;
  kind?: string;
  [key: string]: unknown;
}

export interface TodoItem {
  completed: boolean;
  text?: string;
  [key: string]: unknown;
}

interface BaseStreamItem {
  id: string;
  [key: string]: unknown;
}

export interface CommandExecutionItem extends BaseStreamItem {
  type: "command_execution";
  command: string;
  status: string;
  exit_code?: number;
  aggregated_output?: string;
}

export interface FileChangeItem extends BaseStreamItem {
  type: "file_change";
  status: string;
  changes?: FileChange[];
}

export interface AgentMessageItem extends BaseStreamItem {
  type: "agent_message";
  text?: string;
}

export interface ReasoningItem extends BaseStreamItem {
  type: "reasoning";
  text?: string;
}

export interface TodoListItem extends BaseStreamItem {
  type: "todo_list";
  items: TodoItem[];
}

export interface McpToolCallItem extends BaseStreamItem {
  type: "mcp_tool_call";
  server: string;
  tool: string;
  status: string;
  arguments?: unknown;
  result?: unknown;
  error?: { message?: string } | string;
}

export interface WebSearchItem extends BaseStreamItem {
  type: "web_search";
  query: string;
}

export interface ErrorItem extends BaseStreamItem {
  type: "error";
  message: string;
}

export type StreamItem =
  | CommandExecutionItem
  | FileChangeItem
  | AgentMessageItem
  | ReasoningItem
  | TodoListItem
  | McpToolCallItem
  | WebSearchItem
  | ErrorItem;

export type BatchMode = "repeated" | "generated";

export interface Batch {
  id: string;
  mode: BatchMode;
  title: string;
  status: BatchStatus;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  cancelRequested: boolean;
  error: string | null;
  config: BatchConfig;
  generation: GenerationState | null;
  projectContext?: ProjectContext;
  runs: Run[];
}

export interface Run {
  id: string;
  index: number;
  title: string;
  prompt: string;
  status: RunStatus;
  startedAt: string | null;
  completedAt: string | null;
  threadId: string | null;
  worktreePath: string | null;
  workingDirectory: string | null;
  baseRef: string | null;
  finalResponse: string;
  error: string | null;
  usage: RunUsage | null;
  logs: RunLog[];
  turns: RunTurn[];
  items: StreamItem[];
  review: RunReview | null;
}

export interface BatchSummary {
  id: string;
  mode: BatchMode;
  title: string;
  status: BatchStatus;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  cancelRequested: boolean;
  totalRuns: number;
  completedRuns: number;
  failedRuns: number;
  cancelledRuns: number;
  preparingRuns: number;
  waitingForCodexRuns: number;
  runningRuns: number;
  queuedRuns: number;
  config: BatchConfig;
  generation: GenerationState | null;
}

export interface DirectoryEntry {
  name: string;
  path: string;
}

export interface DirectoryListing {
  path: string;
  parentPath: string | null;
  directories: DirectoryEntry[];
}

export interface ReasoningEffortEntry {
  reasoningEffort: string;
  description: string;
}

export interface CodexModel {
  model: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: ReasoningEffortEntry[];
  hidden: boolean;
  upgrade: string | null;
  upgradeInfo: unknown;
  availabilityNux: unknown;
}

export interface ModelCatalogResponse {
  models: CodexModel[];
  fetchedAt: string;
  stale: boolean;
}

export type CodexCredentialSource = "apiKey" | "profile" | "none";

export type CodexAuthValidationStatus = "checking" | "valid" | "invalid";

export interface CodexAuthValidationResponse {
  status: Exclude<CodexAuthValidationStatus, "checking">;
  checkedAt: string;
  source: CodexCredentialSource;
  authMode: string | null;
  accountLabel: string | null;
  message: string;
}

export interface WorktreeInspection {
  worktreePath: string;
  exists: boolean;
  isDirty: boolean;
  changeCount: number;
  trackedChangeCount: number;
  untrackedChangeCount: number;
  statusEntries: string[];
  error: string;
  runTitle?: string;
  runIndex?: number;
}

export interface BatchDeleteWorktreePreviewEntry extends WorktreeInspection {
  runId: string;
}

export interface BatchDeleteBranchPreviewEntry {
  runId: string;
  runIndex: number;
  runTitle: string;
  branchName: string;
  comparisonRef: string | null;
  exists: boolean;
  aheadCount: number | null;
  behindCount: number | null;
  safeToDelete: boolean;
  canDelete: boolean;
  deleteByDefault: boolean;
  requiresForce: boolean;
  decisionReason: string;
  error: string;
}

export interface BatchDeletePreview {
  batchId: string;
  worktreeCount: number;
  dirtyWorktreeCount: number;
  inspectFailureCount: number;
  worktrees: BatchDeleteWorktreePreviewEntry[];
  branchCount: number;
  safeBranchCount: number;
  riskyBranchCount: number;
  branchInspectFailureCount: number;
  branches: BatchDeleteBranchPreviewEntry[];
}

export interface AppConfig {
  homeDirectory: string;
  defaults: {
    runCount: number;
    sandboxMode: string;
  };
  codexEnvironment: {
    hasOpenAIApiKey: boolean;
    hasCodexProfile: boolean;
  };
}
