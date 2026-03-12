import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { collectWorktreeReview, inspectProject, listDirectories } from "./lib/git.js";
import { createRunStore } from "./lib/runStore.js";
import { cancelRun, deleteRun, generateRunTitle, runMode } from "./lib/runner.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const publicDirectory = path.join(projectRoot, "public");
const dataDirectory = path.join(projectRoot, "data");
const port = Number(process.env.PORT || 3000);

const store = createRunStore(dataDirectory);

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(`${JSON.stringify(payload)}\n`);
}

function sendError(response, statusCode, message) {
  sendJson(response, statusCode, { error: message });
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";

    request.on("data", (chunk) => {
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


async function hasCodexProfile() {
  try {
    await fsp.access(path.join(os.homedir(), ".codex", "auth.json"));
    return true;
  } catch {
    return false;
  }
}

function normalizeInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value ?? fallback), 10);
  if (Number.isNaN(parsed)) {
    return fallback;
  }
  return Math.max(minimum, Math.min(maximum, parsed));
}

function normalizeString(value) {
  return String(value ?? "").trim();
}

function normalizeMode(value) {
  return value === "generated" || value === "task-generator" ? "generated" : "repeated";
}

function getProjectFolderLabel(projectPath) {
  const normalizedPath = String(projectPath ?? "").replace(/[\\/]+$/, "");
  if (!normalizedPath) {
    return "";
  }

  const segments = normalizedPath.split(/[\\/]/).filter(Boolean);
  return segments.at(-1) || normalizedPath;
}

function buildFallbackRunTitle({ mode, runCount, projectPath }) {
  const projectLabel = getProjectFolderLabel(projectPath);
  const modeLabel = mode === "generated" ? "Generated" : "Repeated";
  return projectLabel ? `${projectLabel} - ${modeLabel} x${runCount}` : `${modeLabel} x${runCount}`;
}

function normalizeCreateRunPayload(body) {
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
    title: requestedTitle || buildFallbackRunTitle({ mode, runCount, projectPath: resolvedProjectPath }),
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
      approvalPolicy: normalizeString(body.approvalPolicy) || "never",
      networkAccessEnabled: Boolean(body.networkAccessEnabled),
      webSearchMode: body.webSearchMode === "live" ? "live" : "disabled",
      reasoningEffort: normalizeString(body.reasoningEffort) || "",
    },
  };
}

async function serveStaticFile(response, pathname) {
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
    if (error.code === "ENOENT") {
      sendError(response, 404, "Not found.");
      return;
    }

    throw error;
  }
}

async function handleApi(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/config") {
    sendJson(response, 200, {
      cwd: projectRoot,
      homeDirectory: os.homedir(),
      defaults: {
        port,
        runCount: 10,
        sandboxMode: "workspace-write",
        approvalPolicy: "never",
      },
      codexEnvironment: {
        hasOpenAIApiKey: Boolean(process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY),
        hasCodexProfile: await hasCodexProfile(),

      },
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/runs") {
    sendJson(response, 200, { runs: store.listSummaries() });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/runs") {
    const body = await readBody(request);
    const payload = normalizeCreateRunPayload(body);
    const run = store.createRun(payload);

    if (payload.autoGenerateTitle) {
      void generateRunTitle(store, run.id).catch((error) => {
        console.error(`Run ${run.id} title generation failed`, error);
      });
    }

    void runMode(store, run.id).catch((error) => {
      console.error(`Run ${run.id} failed`, error);
    });

    sendJson(response, 202, { run: store.getRun(run.id) });
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

  const runIdMatch = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
  if (request.method === "GET" && runIdMatch) {
    const run = store.getRun(decodeURIComponent(runIdMatch[1]));
    if (!run) {
      sendError(response, 404, "Run not found.");
      return;
    }
    sendJson(response, 200, { run });
    return;
  }

  if (request.method === "DELETE" && runIdMatch) {
    const run = deleteRun(store, decodeURIComponent(runIdMatch[1]));
    if (!run) {
      sendError(response, 404, "Run not found.");
      return;
    }
    sendJson(response, 200, { run });
    return;
  }

  const cancelMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/cancel$/);
  if (request.method === "POST" && cancelMatch) {
    const run = cancelRun(store, decodeURIComponent(cancelMatch[1]));
    if (!run) {
      sendError(response, 404, "Run not found.");
      return;
    }
    sendJson(response, 202, { run });
    return;
  }

  const reviewMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/agents\/([^/]+)\/review$/);
  if (request.method === "GET" && reviewMatch) {
    const runId = decodeURIComponent(reviewMatch[1]);
    const agentId = decodeURIComponent(reviewMatch[2]);
    const run = store.getRun(runId);

    if (!run) {
      sendError(response, 404, "Run not found.");
      return;
    }

    const agent = run.agents.find((entry) => entry.id === agentId);
    if (!agent) {
      sendError(response, 404, "Agent not found.");
      return;
    }

    if (!agent.worktreePath) {
      sendJson(response, 200, { review: agent.review });
      return;
    }

    const review = await collectWorktreeReview(agent.worktreePath);
    store.updateAgent(runId, agentId, (mutableAgent) => {
      mutableAgent.review = review;
    });
    sendJson(response, 200, { review });
    return;
  }

  sendError(response, 404, "Not found.");
}

async function main() {
  await store.load();

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);

    try {
      if (url.pathname.startsWith("/api/") || url.pathname === "/events") {
        await handleApi(request, response, url);
        return;
      }

      await serveStaticFile(response, url.pathname);
    } catch (error) {
      console.error("Request failed", error);
      if (!response.headersSent) {
        sendError(response, 500, error.message || "Internal server error.");
      } else {
        response.end();
      }
    }
  });

  server.listen(port, () => {
    console.log(`Agents Runner listening on http://localhost:${port}`);
  });
}

main().catch((error) => {
  console.error("Server failed to start", error);
  process.exitCode = 1;
});
