import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { detectCodexAuthStatus } from "./lib/codexAuth";
import { createCodexModelCatalog } from "./lib/codexModels";
import { collectWorktreeReview, inspectProject, listDirectories } from "./lib/git";
import { createBatchStore } from "./lib/batchStore";
import {
  cancelBatch,
  continueRun,
  createRunBranch,
  deleteBatch,
  generateBatchTitle,
  executeBatch,
  previewBatchDelete,
} from "./lib/runner";

import type { BatchMode, CodexAuthValidationResponse } from "./types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const publicDirectory = path.join(projectRoot, "public");
const dataDirectory = path.join(projectRoot, "data");
const port = Number(process.env.PORT || 3000);

const store = createBatchStore(dataDirectory);
const modelCatalog = createCodexModelCatalog();

const mimeTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(`${JSON.stringify(payload)}\n`);
}

function sendError(response: ServerResponse, statusCode: number, message: string): void {
  sendJson(response, statusCode, { error: message });
}

function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = "";

    request.on("data", (chunk: Buffer) => {
      body += chunk.toString();
      if (body.length > 1_000_000) {
        reject(new Error("Request body too large."));
        request.destroy();
      }
    });

    request.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON payload."));
      }
    });

    request.on("error", reject);
  });
}


async function hasCodexProfile(): Promise<boolean> {
  try {
    await fsp.access(path.join(os.homedir(), ".codex", "auth.json"));
    return true;
  } catch {
    return false;
  }
}

async function hasCodexCredentials(): Promise<boolean> {
  return Boolean(process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY || await hasCodexProfile());
}

function normalizeInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number.parseInt(String(value ?? fallback), 10);
  if (Number.isNaN(parsed)) {
    return fallback;
  }
  return Math.max(minimum, Math.min(maximum, parsed));
}

function normalizeString(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeMode(value: unknown): BatchMode {
  return value === "generated" || value === "task-generator" ? "generated" : "repeated";
}

function getProjectFolderLabel(projectPath: string): string {
  const normalizedPath = String(projectPath ?? "").replace(/[\\/]+$/, "");
  if (!normalizedPath) {
    return "";
  }

  const segments = normalizedPath.split(/[\\/]/).filter(Boolean);
  return segments.at(-1) || normalizedPath;
}

function buildFallbackBatchTitle({ mode, runCount, projectPath }: { mode: BatchMode; runCount: number; projectPath: string }): string {
  const projectLabel = getProjectFolderLabel(projectPath);
  const modeLabel = mode === "generated" ? "Generated" : "Repeated";
  return projectLabel ? `${projectLabel} - ${modeLabel} x${runCount}` : `${modeLabel} x${runCount}`;
}

interface NormalizedCreateBatchPayload {
  mode: BatchMode;
  title: string;
  autoGenerateTitle: boolean;
  config: {
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
  };
}

function normalizeCreateBatchPayload(body: Record<string, unknown>): NormalizedCreateBatchPayload {
  const mode = normalizeMode(body.mode ?? body.workflowType);
  const runCount = normalizeInteger(body.runCount, 10, 1, 50);
  const concurrency = normalizeInteger(body.concurrency, runCount, 1, runCount);
  const projectPath = normalizeString(body.projectPath);
  const worktreeRoot = normalizeString(body.worktreeRoot);
  const prompt = normalizeString(body.prompt);
  const taskPrompt = normalizeString(body.taskPrompt);
  const requestedTitle = normalizeString(body.title);

  if (!projectPath) {
    throw new Error("Project path is required.");
  }

  if (mode === "repeated" && !prompt) {
    throw new Error("Prompt is required for Repeated mode.");
  }

  if (mode === "generated" && !taskPrompt) {
    throw new Error("Task generation prompt is required for Generated mode.");
  }

  const resolvedProjectPath = path.resolve(projectPath);
  const resolvedWorktreeRoot = worktreeRoot
    ? path.resolve(worktreeRoot)
    : path.dirname(resolvedProjectPath);

  return {
    mode,
    title: requestedTitle || buildFallbackBatchTitle({ mode, runCount, projectPath: resolvedProjectPath }),
    autoGenerateTitle: !requestedTitle,
    config: {
      runCount,
      concurrency,
      projectPath: resolvedProjectPath,
      worktreeRoot: resolvedWorktreeRoot,
      prompt,
      taskPrompt,
      baseRef: normalizeString(body.baseRef),
      model: normalizeString(body.model),
      sandboxMode: normalizeString(body.sandboxMode) || "workspace-write",
      networkAccessEnabled: Boolean(body.networkAccessEnabled),
      webSearchMode: body.webSearchMode === "live" ? "live" : "disabled",
      reasoningEffort: normalizeString(body.reasoningEffort) || "",
    },
  };
}

function normalizeDeleteBatchPayload(body: Record<string, unknown>): { removeWorktrees: boolean } {
  return {
    removeWorktrees: Boolean(body.removeWorktrees),
  };
}

function normalizeContinueRunPayload(body: Record<string, unknown>): { prompt: string } {
  const prompt = normalizeString(body.prompt);
  if (!prompt) {
    throw new Error("Prompt is required.");
  }

  return { prompt };
}

function normalizeCreateBranchPayload(body: Record<string, unknown>): { branchName: string } {
  const branchName = normalizeString(body.branchName);
  if (!branchName) {
    throw new Error("Branch name is required.");
  }

  return { branchName };
}

async function serveStaticFile(response: ServerResponse, pathname: string): Promise<void> {
  const relativePath = pathname === "/" ? "/index.html" : pathname;
  const targetPath = path.normalize(path.join(publicDirectory, relativePath));

  if (!targetPath.startsWith(publicDirectory)) {
    sendError(response, 403, "Forbidden.");
    return;
  }

  try {
    const stats = await fsp.stat(targetPath);
    if (!stats.isFile()) {
      sendError(response, 404, "Not found.");
      return;
    }

    response.writeHead(200, {
      "Content-Type": mimeTypes[path.extname(targetPath)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    fs.createReadStream(targetPath).pipe(response);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      sendError(response, 404, "Not found.");
      return;
    }

    throw error;
  }
}

async function handleApi(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
  if (request.method === "GET" && url.pathname === "/api/config") {
    sendJson(response, 200, {
      cwd: projectRoot,
      homeDirectory: os.homedir(),
      defaults: {
        port,
        runCount: 10,
        sandboxMode: "workspace-write",
      },
      codexEnvironment: {
        hasOpenAIApiKey: Boolean(process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY),
        hasCodexProfile: await hasCodexProfile(),
      },
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/batches") {
    sendJson(response, 200, { batches: store.listSummaries() });
    return;
  }

  if (
    request.method === "GET"
    && (url.pathname === "/api/auth/status" || url.pathname === "/api/auth/validate")
  ) {
    const checkedAt = new Date().toISOString();
    const status = await detectCodexAuthStatus();
    const payload: CodexAuthValidationResponse = {
      checkedAt,
      ...status,
    };
    sendJson(response, 200, payload);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/models") {
    if (!await hasCodexCredentials()) {
      sendError(
        response,
        503,
        "No Codex credentials detected. Sign in with Codex or set OPENAI_API_KEY/CODEX_API_KEY.",
      );
      return;
    }

    const refresh = url.searchParams.get("refresh") === "1";
    const payload = await modelCatalog.getModels({ refresh });
    sendJson(response, 200, payload);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/batches") {
    const body = await readBody(request);
    const payload = normalizeCreateBatchPayload(body);
    const batch = store.createBatch(payload);

    if (payload.autoGenerateTitle) {
      void generateBatchTitle(store, batch.id).catch((error: unknown) => {
        console.error(`Batch ${batch.id} title generation failed`, error);
      });
    }

    void executeBatch(store, batch.id).catch((error: unknown) => {
      console.error(`Batch ${batch.id} failed`, error);
    });

    sendJson(response, 202, { batch: store.getBatch(batch.id) });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/project/inspect") {
    const body = await readBody(request);
    const targetPath = normalizeString(body.path);

    if (!targetPath) {
      throw new Error("Path is required.");
    }

    const projectContext = await inspectProject(path.resolve(targetPath));
    sendJson(response, 200, { projectContext });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/fs") {
    const listing = await listDirectories(url.searchParams.get("path") || undefined);
    sendJson(response, 200, listing);
    return;
  }

  if (request.method === "GET" && url.pathname === "/events") {
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    });
    response.write("\n");

    const unsubscribe = store.subscribe(response);
    const keepAlive = setInterval(() => {
      response.write(": keep-alive\n\n");
    }, 15_000);

    request.on("close", () => {
      clearInterval(keepAlive);
      unsubscribe();
    });
    return;
  }

  const batchIdMatch = url.pathname.match(/^\/api\/batches\/([^/]+)$/);
  const deletePreviewMatch = url.pathname.match(/^\/api\/batches\/([^/]+)\/delete-preview$/);

  if (request.method === "GET" && deletePreviewMatch) {
    const preview = await previewBatchDelete(store, decodeURIComponent(deletePreviewMatch[1]));
    if (!preview) {
      sendError(response, 404, "Batch not found.");
      return;
    }

    sendJson(response, 200, { preview });
    return;
  }

  if (request.method === "GET" && batchIdMatch) {
    const batch = store.getBatch(decodeURIComponent(batchIdMatch[1]));
    if (!batch) {
      sendError(response, 404, "Batch not found.");
      return;
    }
    sendJson(response, 200, { batch });
    return;
  }

  if (request.method === "DELETE" && batchIdMatch) {
    const body = await readBody(request);
    const payload = normalizeDeleteBatchPayload(body);

    try {
      const result = await deleteBatch(store, decodeURIComponent(batchIdMatch[1]), payload);
      if (!result) {
        sendError(response, 404, "Batch not found.");
        return;
      }

      sendJson(response, 200, result);
    } catch (error) {
      if ((error as { statusCode?: number })?.statusCode === 409) {
        sendJson(response, 409, {
          error: (error as Error).message || "Failed to remove worktrees.",
          details: (error as { details?: unknown }).details || null,
        });
        return;
      }

      throw error;
    }
    return;
  }

  const cancelMatch = url.pathname.match(/^\/api\/batches\/([^/]+)\/cancel$/);
  if (request.method === "POST" && cancelMatch) {
    const batch = cancelBatch(store, decodeURIComponent(cancelMatch[1]));
    if (!batch) {
      sendError(response, 404, "Batch not found.");
      return;
    }
    sendJson(response, 202, { batch });
    return;
  }

  const continueRunMatch = url.pathname.match(/^\/api\/batches\/([^/]+)\/runs\/([^/]+)\/continue$/);
  if (request.method === "POST" && continueRunMatch) {
    const body = await readBody(request);
    const payload = normalizeContinueRunPayload(body);

    try {
      const batch = await continueRun(
        store,
        decodeURIComponent(continueRunMatch[1]),
        decodeURIComponent(continueRunMatch[2]),
        payload.prompt,
      );

      if (!batch) {
        sendError(response, 404, "Batch not found.");
        return;
      }

      sendJson(response, 202, { batch });
    } catch (error) {
      sendError(response, 409, (error as Error).message || "Failed to continue run.");
    }
    return;
  }

  const branchMatch = url.pathname.match(/^\/api\/batches\/([^/]+)\/runs\/([^/]+)\/branch$/);
  if (request.method === "POST" && branchMatch) {
    const body = await readBody(request);
    const payload = normalizeCreateBranchPayload(body);

    try {
      const batch = await createRunBranch(
        store,
        decodeURIComponent(branchMatch[1]),
        decodeURIComponent(branchMatch[2]),
        payload.branchName,
      );

      if (!batch) {
        sendError(response, 404, "Batch not found.");
        return;
      }

      sendJson(response, 200, { batch });
    } catch (error) {
      sendError(response, 409, (error as Error).message || "Failed to create branch.");
    }
    return;
  }

  const reviewMatch = url.pathname.match(/^\/api\/batches\/([^/]+)\/runs\/([^/]+)\/review$/);
  if (request.method === "GET" && reviewMatch) {
    const batchId = decodeURIComponent(reviewMatch[1]);
    const runId = decodeURIComponent(reviewMatch[2]);
    const batch = store.getBatch(batchId);

    if (!batch) {
      sendError(response, 404, "Batch not found.");
      return;
    }

    const run = batch.runs.find((entry) => entry.id === runId);
    if (!run) {
      sendError(response, 404, "Run not found.");
      return;
    }

    if (!run.worktreePath) {
      sendJson(response, 200, { review: run.review });
      return;
    }

    const review = await collectWorktreeReview(run.worktreePath);
    store.updateRun(batchId, runId, (mutableRun) => {
      mutableRun.review = review;
    });
    sendJson(response, 200, { review });
    return;
  }

  sendError(response, 404, "Not found.");
}

async function main(): Promise<void> {
  await store.load();

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url!, `http://${request.headers.host || "localhost"}`);

    try {
      if (url.pathname.startsWith("/api/") || url.pathname === "/events") {
        await handleApi(request, response, url);
        return;
      }

      await serveStaticFile(response, url.pathname);
    } catch (error) {
      console.error("Request failed", error);
      if (!response.headersSent) {
        sendError(response, 500, (error as Error).message || "Internal server error.");
      } else {
        response.end();
      }
    }
  });

  server.listen(port, () => {
    console.log(`Agents Runner listening on http://localhost:${port}`);
  });
}

main().catch((error: unknown) => {
  console.error("Server failed to start", error);
  process.exitCode = 1;
});
