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

function upsertItem(agent, item) {
  const nextItem = sanitizeItem(item);
  const existingIndex = agent.items.findIndex((entry) => entry.id === nextItem.id);

  if (existingIndex >= 0) {
    agent.items[existingIndex] = nextItem;
  } else {
    agent.items.push(nextItem);
  }
}

function appendLog(agent, level, message) {
  agent.logs.push({
    at: nowIso(),
    level,
    message: truncateText(message, 1_200),
  });

  if (agent.logs.length > MAX_LOG_ENTRIES) {
    agent.logs.splice(0, agent.logs.length - MAX_LOG_ENTRIES);
  }
}

function getCodexClient() {
  return new Codex({
    apiKey: process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY,
    baseUrl: process.env.OPENAI_BASE_URL || process.env.CODEX_BASE_URL,

  });
}

function getExecutionState(runId) {
  if (!executionRegistry.has(runId)) {
    executionRegistry.set(runId, {
      generationController: null,
      agentControllers: new Map(),
    });
  }

  return executionRegistry.get(runId);
}

function clearExecutionState(runId) {
  executionRegistry.delete(runId);
}

function buildAgentRecord(task, index) {
  return {
    id: `agent-${index + 1}-${Math.random().toString(36).slice(2, 8)}`,
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

function buildRunTitleSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["title"],
    properties: {
      title: { type: "string", minLength: 1, maxLength: 80 },
    },
  };
}

function buildRunTitlePrompt(run) {
  const sourcePrompt = run.mode === "generated" ? run.config.taskPrompt : run.config.prompt;
  const projectFolder = getProjectFolderName(run.config.projectPath);

  return [
    "Name this coding run for a dashboard.",
    "Write a concise title that captures the actual engineering goal from the user's prompt.",
    "Requirements:",
    "- 3 to 7 words.",
    "- Specific and concrete.",
    "- No quotes.",
    "- No trailing punctuation.",
    "- Avoid generic words like workflow, run, agent, repeated, or generated unless they are required for clarity.",
    `Project folder: ${projectFolder || run.config.projectPath}`,
    `Mode: ${run.mode}`,
    `Agent count: ${run.config.runCount}`,
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
      return "Agent produced a response.";
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

function deriveRunStatus(run) {
  if (run.cancelRequested && run.agents.every((agent) => agent.status === "cancelled" || agent.status === "completed" || agent.status === "failed")) {
    return "cancelled";
  }

  if (run.agents.some((agent) => agent.status === "failed")) {
    return "failed";
  }

  if (run.agents.every((agent) => agent.status === "completed")) {
    return "completed";
  }

  if (run.agents.some((agent) => agent.status === "running")) {
    return "running";
  }

  if (run.cancelRequested) {
    return "cancelled";
  }

  return "queued";
}

async function generateTasks(store, runId, projectContext) {
  const run = store.getRun(runId);
  const execution = getExecutionState(runId);
  const controller = new AbortController();
  execution.generationController = controller;

  store.updateRun(runId, (mutableRun) => {
    mutableRun.generation.status = "running";
    mutableRun.generation.startedAt = nowIso();
    mutableRun.generation.error = null;
  });

  try {
    const codex = getCodexClient();
    const thread = codex.startThread({
      model: run.config.model || undefined,
      sandboxMode: run.config.sandboxMode,
      approvalPolicy: run.config.approvalPolicy,
      workingDirectory: projectContext.projectPath,
      networkAccessEnabled: run.config.networkAccessEnabled,
      webSearchEnabled: run.config.webSearchMode !== "disabled",
      webSearchMode: run.config.webSearchMode,
      modelReasoningEffort: run.config.reasoningEffort || undefined,
    });

    const result = await thread.run(buildTaskGenerationPrompt(run.config.taskPrompt, run.config.runCount), {
      signal: controller.signal,
      outputSchema: buildTaskSchema(run.config.runCount),
    });

    const parsed = JSON.parse(result.finalResponse);
    const tasks = parsed.tasks.map((task, index) => ({
      title: task.title || `Task ${index + 1}`,
      prompt: task.prompt,
    }));

    store.updateRun(runId, (mutableRun) => {
      mutableRun.generation.status = "completed";
      mutableRun.generation.completedAt = nowIso();
      mutableRun.generation.tasks = tasks;
    });

    return tasks;
  } catch (error) {
    const message = isAbortError(error) ? "Task generation cancelled." : error.message;

    store.updateRun(runId, (mutableRun) => {
      mutableRun.generation.status = isAbortError(error) ? "cancelled" : "failed";
      mutableRun.generation.completedAt = nowIso();
      mutableRun.generation.error = message;
      mutableRun.error = message;
    });

    throw error;
  } finally {
    const latestExecution = getExecutionState(runId);
    latestExecution.generationController = null;
  }
}

export async function generateRunTitle(store, runId) {
  const run = store.getRun(runId);
  if (!run) {
    return null;
  }

  const sourcePrompt = run.mode === "generated" ? run.config.taskPrompt : run.config.prompt;
  if (!sourcePrompt) {
    return run.title;
  }

  const codex = getCodexClient();
  const thread = codex.startThread({
    model: run.config.model || undefined,
    sandboxMode: "read-only",
    approvalPolicy: "never",
    workingDirectory: run.config.projectPath,
    networkAccessEnabled: false,
    webSearchEnabled: false,
    webSearchMode: "disabled",
    modelReasoningEffort: "low",
  });

  const result = await thread.run(buildRunTitlePrompt(run), {
    outputSchema: buildRunTitleSchema(),
  });

  const parsed = JSON.parse(result.finalResponse);
  const nextTitle = sanitizeGeneratedTitle(parsed.title, run.title);

  store.updateRun(runId, (mutableRun) => {
    mutableRun.title = nextTitle;
  });

  return nextTitle;
}

async function executeAgent(store, runId, agentId, projectContext) {
  const run = store.getRun(runId);
  const agentSnapshot = run.agents.find((entry) => entry.id === agentId);
  const execution = getExecutionState(runId);
  const controller = new AbortController();
  execution.agentControllers.set(agentId, controller);

  let worktreePath = null;

  store.updateAgent(runId, agentId, (agent) => {
    agent.status = "running";
    agent.startedAt = nowIso();
    appendLog(agent, "info", "Preparing git worktree.");
  });

  try {
    const baseRef = run.config.baseRef || projectContext.branchName || projectContext.headSha;
    worktreePath = await createWorktree({
      repoRoot: projectContext.repoRoot,
      projectPath: projectContext.projectPath,
      worktreeRoot: run.config.worktreeRoot,
      baseRef,
      branchName: projectContext.branchName,
      headSha: projectContext.headSha,
      agentIndex: agentSnapshot.index,
    });

    const workingDirectory =
      projectContext.relativeProjectPath === "."
        ? worktreePath
        : path.join(worktreePath, projectContext.relativeProjectPath);

    store.updateAgent(runId, agentId, (agent) => {
      agent.worktreePath = worktreePath;
      agent.workingDirectory = workingDirectory;
      agent.baseRef = baseRef;
      appendLog(agent, "info", `Worktree ready at ${worktreePath}.`);
    });

    const codex = getCodexClient();
    const thread = codex.startThread({
      model: run.config.model || undefined,
      sandboxMode: run.config.sandboxMode,
      approvalPolicy: run.config.approvalPolicy,
      workingDirectory,
      networkAccessEnabled: run.config.networkAccessEnabled,
      webSearchEnabled: run.config.webSearchMode !== "disabled",
      webSearchMode: run.config.webSearchMode,
      modelReasoningEffort: run.config.reasoningEffort || undefined,
    });

    const { events } = await thread.runStreamed(agentSnapshot.prompt, {
      signal: controller.signal,
    });

    for await (const event of events) {
      store.updateAgent(runId, agentId, (agent) => {
        switch (event.type) {
          case "thread.started":
            agent.threadId = event.thread_id;
            appendLog(agent, "info", `Thread started: ${event.thread_id}`);
            break;
          case "turn.started":
            appendLog(agent, "info", "Codex turn started.");
            break;
          case "turn.completed":
            agent.usage = event.usage;
            appendLog(agent, "info", event.usage
              ? `Turn completed. Tokens in/out: ${event.usage.input_tokens}/${event.usage.output_tokens}.`
              : "Turn completed.");
            break;
          case "turn.failed":
            agent.error = event.error.message;
            appendLog(agent, "error", event.error.message);
            break;
          case "item.started":
            upsertItem(agent, event.item);
            appendLog(agent, "info", describeItem(event.item));
            break;
          case "item.updated":
            upsertItem(agent, event.item);
            break;
          case "item.completed":
            upsertItem(agent, event.item);
            if (event.item.type === "agent_message") {
              agent.finalResponse = truncateText(event.item.text ?? "");
            }
            if (event.item.type === "error") {
              agent.error = event.item.message;
            }
            appendLog(agent, "info", describeItem(event.item));
            break;
          case "error":
            agent.error = event.message;
            appendLog(agent, "error", event.message);
            break;
          default:
            break;
        }
      });
    }

    const review = worktreePath ? await collectWorktreeReview(worktreePath) : null;

    store.updateAgent(runId, agentId, (agent) => {
      agent.status = agent.error ? "failed" : "completed";
      agent.completedAt = nowIso();
      agent.review = review;

      if (!agent.error) {
        appendLog(agent, "info", "Agent run completed.");
      }
    });
  } catch (error) {
    const cancelled = isAbortError(error) || store.getMutableRun(runId)?.cancelRequested;
    const review = worktreePath ? await collectWorktreeReview(worktreePath).catch(() => null) : null;

    store.updateAgent(runId, agentId, (agent) => {
      agent.status = cancelled ? "cancelled" : "failed";
      agent.completedAt = nowIso();
      agent.error = cancelled ? "Run cancelled." : error.message;
      agent.review = review ?? agent.review;
      appendLog(agent, cancelled ? "warning" : "error", agent.error);
    });
  } finally {
    execution.agentControllers.delete(agentId);
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

export async function runMode(store, runId) {
  const run = store.getRun(runId);
  if (!run) {
    return;
  }

  const execution = getExecutionState(runId);

  store.updateRun(runId, (mutableRun) => {
    mutableRun.status = "running";
    mutableRun.startedAt = nowIso();
  });

  try {
    const projectContext = await inspectProject(run.config.projectPath);
    store.updateRun(runId, (mutableRun) => {
      mutableRun.projectContext = projectContext;
    });

    const tasks =
      run.mode === "generated"
        ? await generateTasks(store, runId, projectContext)
        : Array.from({ length: run.config.runCount }, (_, index) => ({
            title: `Run ${index + 1}`,
            prompt: run.config.prompt,
          }));

    for (const [index, task] of tasks.entries()) {
      store.appendAgent(runId, buildAgentRecord(task, index));
    }

    const latestRun = store.getRun(runId);
    await runWithConcurrency(latestRun.agents, latestRun.config.concurrency, async (agent) => {
      const mutableRun = store.getMutableRun(runId);
      if (!mutableRun || mutableRun.cancelRequested) {
        store.updateAgent(runId, agent.id, (mutableAgent) => {
          mutableAgent.status = "cancelled";
          mutableAgent.completedAt = nowIso();
          mutableAgent.error = "Run cancelled before start.";
          appendLog(mutableAgent, "warning", mutableAgent.error);
        });
        return;
      }

      await executeAgent(store, runId, agent.id, projectContext);
    });

    store.updateRun(runId, (mutableRun) => {
      mutableRun.status = deriveRunStatus(mutableRun);
      mutableRun.completedAt = nowIso();
    });
  } catch (error) {
    const cancelled = isAbortError(error) || store.getMutableRun(runId)?.cancelRequested;

    store.updateRun(runId, (mutableRun) => {
      mutableRun.status = cancelled ? "cancelled" : "failed";
      mutableRun.completedAt = nowIso();
      mutableRun.error = cancelled ? "Run cancelled." : error.message;

      for (const agent of mutableRun.agents) {
        if (agent.status === "queued") {
          agent.status = cancelled ? "cancelled" : "failed";
          agent.completedAt = nowIso();
          agent.error = mutableRun.error;
        }
      }
    });
  } finally {
    execution.generationController?.abort();
    for (const controller of execution.agentControllers.values()) {
      controller.abort();
    }
    clearExecutionState(runId);
  }
}

export function cancelRun(store, runId) {
  const run = store.getMutableRun(runId);
  if (!run) {
    return null;
  }

  run.cancelRequested = true;
  if (run.status === "queued") {
    run.status = "cancelled";
    run.completedAt = nowIso();
  }

  const execution = executionRegistry.get(runId);
  execution?.generationController?.abort();
  for (const controller of execution?.agentControllers.values() ?? []) {
    controller.abort();
  }

  store.updateRun(runId, () => {});
  return store.getRun(runId);
}
