import path from "node:path";

import { Codex } from "@openai/codex-sdk";

import { collectWorktreeReview, createWorktree, inspectProject } from "./git.js";
import { isAbortError } from "./process.js";

const MAX_LOG_ENTRIES = 160;
const MAX_TEXT_LENGTH = 24_000;
const executionRegistry = new Map();

function nowIso() {
  return new Date().toISOString();
}

function truncateText(value, limit = MAX_TEXT_LENGTH) {
  const text = String(value ?? "");
  if (text.length <= limit) {
    return text;
  }

  return `${text.slice(0, limit)}\n\n...truncated...`;
}

function compactJson(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

function sanitizeItem(item) {
  if (!item || typeof item !== "object") {
    return item;
  }

  const clone = compactJson(item);

  if (clone.type === "command_execution") {
    clone.aggregated_output = truncateText(clone.aggregated_output ?? "");
  }

  if (clone.type === "mcp_tool_call" && clone.result) {
    clone.result = compactJson(clone.result);
  }

  if (clone.type === "agent_message") {
    clone.text = truncateText(clone.text ?? "");
  }

  if (clone.type === "reasoning") {
    clone.text = truncateText(clone.text ?? "", 8_000);
  }

  if (clone.type === "error") {
    clone.message = truncateText(clone.message ?? "", 4_000);
  }

  return clone;
}

function upsertItem(run, item) {
  const nextItem = sanitizeItem(item);
  const existingIndex = run.items.findIndex((entry) => entry.id === nextItem.id);

  if (existingIndex >= 0) {
    run.items[existingIndex] = nextItem;
  } else {
    run.items.push(nextItem);
  }
}

function appendLog(run, level, message) {
  run.logs.push({
    at: nowIso(),
    level,
    message: truncateText(message, 1_200),
  });

  if (run.logs.length > MAX_LOG_ENTRIES) {
    run.logs.splice(0, run.logs.length - MAX_LOG_ENTRIES);
  }
}

function getCodexClient() {
  return new Codex({
    apiKey: process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY,
    baseUrl: process.env.OPENAI_BASE_URL || process.env.CODEX_BASE_URL,

  });
}

function getExecutionState(batchId) {
  if (!executionRegistry.has(batchId)) {
    executionRegistry.set(batchId, {
      titleController: null,
      generationController: null,
      runControllers: new Map(),
    });
  }

  return executionRegistry.get(batchId);
}

function clearExecutionState(batchId) {
  executionRegistry.delete(batchId);
}

function maybeClearExecutionState(batchId, execution) {
  if (!execution) {
    return;
  }

  if (execution.titleController || execution.generationController || execution.runControllers.size > 0) {
    return;
  }

  if (executionRegistry.get(batchId) === execution) {
    clearExecutionState(batchId);
  }
}

function buildRunRecord(task, index) {
  return {
    id: `run-${index + 1}-${Math.random().toString(36).slice(2, 8)}`,
    index,
    title: task.title,
    prompt: task.prompt,
    status: "queued",
    startedAt: null,
    completedAt: null,
    threadId: null,
    worktreePath: null,
    workingDirectory: null,
    baseRef: null,
    finalResponse: "",
    error: null,
    usage: null,
    logs: [],
    items: [],
    review: null,
  };
}

function buildTaskSchema(count) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["tasks"],
    properties: {
      tasks: {
        type: "array",
        minItems: count,
        maxItems: count,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["title", "prompt"],
          properties: {
            title: { type: "string", minLength: 1, maxLength: 120 },
            prompt: { type: "string", minLength: 1 },
          },
        },
      },
    },
  };
}

function buildTaskGenerationPrompt(userPrompt, count) {
  return [
    userPrompt.trim(),
    "",
    `Generate exactly ${count} coding tasks for parallel Codex execution.`,
    "Each task will run in its own git worktree cloned from the same repository state.",
    "Prefer tasks that do not overlap heavily in files or responsibilities.",
    "Each prompt must be self-contained, concrete, and directly runnable by an autonomous coding agent.",
    'Return only JSON that matches the provided schema with a top-level "tasks" array.',
  ].join("\n");
}

function getProjectFolderName(projectPath) {
  const normalizedPath = String(projectPath ?? "").trim().replace(/[\\/]+$/, "");
  if (!normalizedPath) {
    return "";
  }

  const parts = normalizedPath.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) || normalizedPath;
}

function buildBatchTitleSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["title"],
    properties: {
      title: { type: "string", minLength: 1, maxLength: 80 },
    },
  };
}

function buildBatchTitlePrompt(batch) {
  const sourcePrompt = batch.mode === "generated" ? batch.config.taskPrompt : batch.config.prompt;
  const projectFolder = getProjectFolderName(batch.config.projectPath);

  return [
    "Name this coding batch for a dashboard.",
    "Write a concise title that captures the actual engineering goal from the user's prompt.",
    "Requirements:",
    "- 3 to 7 words.",
    "- Specific and concrete.",
    "- No quotes.",
    "- No trailing punctuation.",
    "- Avoid generic words like workflow, batch, run, agent, repeated, or generated unless they are required for clarity.",
    `Project folder: ${projectFolder || batch.config.projectPath}`,
    `Mode: ${batch.mode}`,
    `Run count: ${batch.config.runCount}`,
    "User prompt:",
    truncateText(sourcePrompt, 4_000),
    'Return JSON with a single "title" field.',
  ].join("\n");
}

function sanitizeGeneratedTitle(value, fallback) {
  const normalized = String(value ?? "")
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\s+/g, " ")
    .replace(/[.!?,;:]+$/g, "");

  if (!normalized) {
    return fallback;
  }

  return normalized.slice(0, 80);
}

function describeItem(item) {
  switch (item.type) {
    case "command_execution":
      return `${item.status === "failed" ? "Command failed" : "Command"}: ${item.command}`;
    case "file_change":
      return `Patch ${item.status}: ${(item.changes || []).map((change) => change.path).join(", ") || "file updates"}`;
    case "agent_message":
      return "Codex produced a response.";
    case "reasoning":
      return "Reasoning summary updated.";
    case "todo_list":
      return `Todo list updated (${item.items.filter((entry) => entry.completed).length}/${item.items.length}).`;
    case "mcp_tool_call":
      return `${item.server}.${item.tool} ${item.status}`;
    case "web_search":
      return `Web search: ${item.query}`;
    case "error":
      return `Error: ${item.message}`;
    default:
      return item.type;
  }
}

function deriveBatchStatus(batch) {
  if (batch.cancelRequested && batch.runs.every((run) => run.status === "cancelled" || run.status === "completed" || run.status === "failed")) {
    return "cancelled";
  }

  if (batch.runs.some((run) => run.status === "failed")) {
    return "failed";
  }

  if (batch.runs.every((run) => run.status === "completed")) {
    return "completed";
  }

  if (batch.runs.some((run) => run.status === "running")) {
    return "running";
  }

  if (batch.cancelRequested) {
    return "cancelled";
  }

  return "queued";
}

async function generateTasks(store, batchId, projectContext) {
  const batch = store.getBatch(batchId);
  const execution = getExecutionState(batchId);
  const controller = new AbortController();
  execution.generationController = controller;

  store.updateBatch(batchId, (mutableBatch) => {
    mutableBatch.generation.status = "running";
    mutableBatch.generation.startedAt = nowIso();
    mutableBatch.generation.error = null;
  });

  try {
    const codex = getCodexClient();
    const thread = codex.startThread({
      model: batch.config.model || undefined,
      sandboxMode: batch.config.sandboxMode,
      approvalPolicy: batch.config.approvalPolicy,
      workingDirectory: projectContext.projectPath,
      networkAccessEnabled: batch.config.networkAccessEnabled,
      webSearchEnabled: batch.config.webSearchMode !== "disabled",
      webSearchMode: batch.config.webSearchMode,
      modelReasoningEffort: batch.config.reasoningEffort || undefined,
    });

    const result = await thread.run(buildTaskGenerationPrompt(batch.config.taskPrompt, batch.config.runCount), {
      signal: controller.signal,
      outputSchema: buildTaskSchema(batch.config.runCount),
    });

    const parsed = JSON.parse(result.finalResponse);
    const tasks = parsed.tasks.map((task, index) => ({
      title: task.title || `Task ${index + 1}`,
      prompt: task.prompt,
    }));

    store.updateBatch(batchId, (mutableBatch) => {
      mutableBatch.generation.status = "completed";
      mutableBatch.generation.completedAt = nowIso();
      mutableBatch.generation.tasks = tasks;
    });

    return tasks;
  } catch (error) {
    const message = isAbortError(error) ? "Task generation cancelled." : error.message;

    store.updateBatch(batchId, (mutableBatch) => {
      mutableBatch.generation.status = isAbortError(error) ? "cancelled" : "failed";
      mutableBatch.generation.completedAt = nowIso();
      mutableBatch.generation.error = message;
      mutableBatch.error = message;
    });

    throw error;
  } finally {
    execution.generationController = null;
    maybeClearExecutionState(batchId, execution);
  }
}

export async function generateBatchTitle(store, batchId) {
  const batch = store.getBatch(batchId);
  if (!batch) {
    return null;
  }

  const sourcePrompt = batch.mode === "generated" ? batch.config.taskPrompt : batch.config.prompt;
  if (!sourcePrompt) {
    return batch.title;
  }

  const execution = getExecutionState(batchId);
  const controller = new AbortController();
  execution.titleController = controller;

  const codex = getCodexClient();
  const thread = codex.startThread({
    model: batch.config.model || undefined,
    sandboxMode: "read-only",
    approvalPolicy: "never",
    workingDirectory: batch.config.projectPath,
    networkAccessEnabled: false,
    webSearchEnabled: false,
    webSearchMode: "disabled",
    modelReasoningEffort: "low",
  });

  try {
    const result = await thread.run(buildBatchTitlePrompt(batch), {
      signal: controller.signal,
      outputSchema: buildBatchTitleSchema(),
    });

    const parsed = JSON.parse(result.finalResponse);
    const nextTitle = sanitizeGeneratedTitle(parsed.title, batch.title);

    store.updateBatch(batchId, (mutableBatch) => {
      mutableBatch.title = nextTitle;
    });

    return nextTitle;
  } catch (error) {
    if (isAbortError(error) || !store.getMutableBatch(batchId)) {
      return null;
    }
    throw error;
  } finally {
    execution.titleController = null;
    maybeClearExecutionState(batchId, execution);
  }
}

async function executeRun(store, batchId, runId, projectContext) {
  const batch = store.getBatch(batchId);
  const runSnapshot = batch.runs.find((entry) => entry.id === runId);
  const execution = getExecutionState(batchId);
  const controller = new AbortController();
  execution.runControllers.set(runId, controller);

  let worktreePath = null;

  store.updateRun(batchId, runId, (run) => {
    run.status = "running";
    run.startedAt = nowIso();
    appendLog(run, "info", "Preparing git worktree.");
  });

  try {
    const baseRef = batch.config.baseRef || projectContext.branchName || projectContext.headSha;
    worktreePath = await createWorktree({
      repoRoot: projectContext.repoRoot,
      projectPath: projectContext.projectPath,
      worktreeRoot: batch.config.worktreeRoot,
      baseRef,
      branchName: projectContext.branchName,
      headSha: projectContext.headSha,
      runIndex: runSnapshot.index,
    });

    const workingDirectory =
      projectContext.relativeProjectPath === "."
        ? worktreePath
        : path.join(worktreePath, projectContext.relativeProjectPath);

    store.updateRun(batchId, runId, (run) => {
      run.worktreePath = worktreePath;
      run.workingDirectory = workingDirectory;
      run.baseRef = baseRef;
      appendLog(run, "info", `Worktree ready at ${worktreePath}.`);
    });

    const codex = getCodexClient();
    const thread = codex.startThread({
      model: batch.config.model || undefined,
      sandboxMode: batch.config.sandboxMode,
      approvalPolicy: batch.config.approvalPolicy,
      workingDirectory,
      networkAccessEnabled: batch.config.networkAccessEnabled,
      webSearchEnabled: batch.config.webSearchMode !== "disabled",
      webSearchMode: batch.config.webSearchMode,
      modelReasoningEffort: batch.config.reasoningEffort || undefined,
    });

    const { events } = await thread.runStreamed(runSnapshot.prompt, {
      signal: controller.signal,
    });

    for await (const event of events) {
      store.updateRun(batchId, runId, (run) => {
        switch (event.type) {
          case "thread.started":
            run.threadId = event.thread_id;
            appendLog(run, "info", `Thread started: ${event.thread_id}`);
            break;
          case "turn.started":
            appendLog(run, "info", "Codex turn started.");
            break;
          case "turn.completed":
            run.usage = event.usage;
            appendLog(run, "info", event.usage
              ? `Turn completed. Tokens in/out: ${event.usage.input_tokens}/${event.usage.output_tokens}.`
              : "Turn completed.");
            break;
          case "turn.failed":
            run.error = event.error.message;
            appendLog(run, "error", event.error.message);
            break;
          case "item.started":
            upsertItem(run, event.item);
            appendLog(run, "info", describeItem(event.item));
            break;
          case "item.updated":
            upsertItem(run, event.item);
            break;
          case "item.completed":
            upsertItem(run, event.item);
            if (event.item.type === "agent_message") {
              run.finalResponse = truncateText(event.item.text ?? "");
            }
            if (event.item.type === "error") {
              run.error = event.item.message;
            }
            appendLog(run, "info", describeItem(event.item));
            break;
          case "error":
            run.error = event.message;
            appendLog(run, "error", event.message);
            break;
          default:
            break;
        }
      });
    }

    const review = worktreePath ? await collectWorktreeReview(worktreePath) : null;

    store.updateRun(batchId, runId, (run) => {
      run.status = run.error ? "failed" : "completed";
      run.completedAt = nowIso();
      run.review = review;

      if (!run.error) {
        appendLog(run, "info", "Run completed.");
      }
    });
  } catch (error) {
    const cancelled = isAbortError(error) || store.getMutableBatch(batchId)?.cancelRequested;
    const review = worktreePath ? await collectWorktreeReview(worktreePath).catch(() => null) : null;

    store.updateRun(batchId, runId, (run) => {
      run.status = cancelled ? "cancelled" : "failed";
      run.completedAt = nowIso();
      run.error = cancelled ? "Batch cancelled." : error.message;
      run.review = review ?? run.review;
      appendLog(run, cancelled ? "warning" : "error", run.error);
    });
  } finally {
    execution.runControllers.delete(runId);
    maybeClearExecutionState(batchId, execution);
  }
}

async function runWithConcurrency(items, concurrency, worker) {
  let index = 0;
  const activeWorkers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (true) {
      const currentIndex = index;
      index += 1;

      if (currentIndex >= items.length) {
        return;
      }

      await worker(items[currentIndex], currentIndex);
    }
  });

  await Promise.all(activeWorkers);
}

export async function executeBatch(store, batchId) {
  const batch = store.getBatch(batchId);
  if (!batch) {
    return;
  }

  const execution = getExecutionState(batchId);

  store.updateBatch(batchId, (mutableBatch) => {
    mutableBatch.status = "running";
    mutableBatch.startedAt = nowIso();
  });

  try {
    const projectContext = await inspectProject(batch.config.projectPath);
    store.updateBatch(batchId, (mutableBatch) => {
      mutableBatch.projectContext = projectContext;
    });

    const tasks =
      batch.mode === "generated"
        ? await generateTasks(store, batchId, projectContext)
        : Array.from({ length: batch.config.runCount }, (_, index) => ({
            title: `Run ${index + 1}`,
            prompt: batch.config.prompt,
          }));

    for (const [index, task] of tasks.entries()) {
      store.appendRun(batchId, buildRunRecord(task, index));
    }

    const latestBatch = store.getBatch(batchId);
    await runWithConcurrency(latestBatch.runs, latestBatch.config.concurrency, async (run) => {
      const mutableBatch = store.getMutableBatch(batchId);
      if (!mutableBatch || mutableBatch.cancelRequested) {
        store.updateRun(batchId, run.id, (mutableRun) => {
          mutableRun.status = "cancelled";
          mutableRun.completedAt = nowIso();
          mutableRun.error = "Batch cancelled before start.";
          appendLog(mutableRun, "warning", mutableRun.error);
        });
        return;
      }

      await executeRun(store, batchId, run.id, projectContext);
    });

    store.updateBatch(batchId, (mutableBatch) => {
      mutableBatch.status = deriveBatchStatus(mutableBatch);
      mutableBatch.completedAt = nowIso();
    });
  } catch (error) {
    const cancelled = isAbortError(error) || store.getMutableBatch(batchId)?.cancelRequested;

    store.updateBatch(batchId, (mutableBatch) => {
      mutableBatch.status = cancelled ? "cancelled" : "failed";
      mutableBatch.completedAt = nowIso();
      mutableBatch.error = cancelled ? "Batch cancelled." : error.message;

      for (const run of mutableBatch.runs) {
        if (run.status === "queued") {
          run.status = cancelled ? "cancelled" : "failed";
          run.completedAt = nowIso();
          run.error = mutableBatch.error;
        }
      }
    });
  } finally {
    execution.generationController?.abort();
    for (const controller of execution.runControllers.values()) {
      controller.abort();
    }
    execution.generationController = null;
    execution.runControllers.clear();
    maybeClearExecutionState(batchId, execution);
  }
}

export function cancelBatch(store, batchId) {
  const batch = store.getMutableBatch(batchId);
  if (!batch) {
    return null;
  }

  batch.cancelRequested = true;
  if (batch.status === "queued") {
    batch.status = "cancelled";
    batch.completedAt = nowIso();
  }

  const execution = executionRegistry.get(batchId);
  execution?.titleController?.abort();
  execution?.generationController?.abort();
  for (const controller of execution?.runControllers.values() ?? []) {
    controller.abort();
  }

  store.updateBatch(batchId, () => {});
  return store.getBatch(batchId);
}

export function deleteBatch(store, batchId) {
  const batch = store.getMutableBatch(batchId);
  if (!batch) {
    return null;
  }

  batch.cancelRequested = true;

  const execution = executionRegistry.get(batchId);
  execution?.titleController?.abort();
  execution?.generationController?.abort();
  for (const controller of execution?.runControllers.values() ?? []) {
    controller.abort();
  }

  clearExecutionState(batchId);
  return store.deleteBatch(batchId);
}
