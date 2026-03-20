import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, expect, test } from "bun:test";

import { runCommand } from "../lib/process";
import { handleMcpRequest } from "./mcp";

import type { AddressInfo } from "node:net";
import type { Batch, BatchStore, ModelCatalog } from "../types";
import type { ServerContext } from "./context";

const tempDirectories: string[] = [];
const activeServers = new Set<http.Server>();

afterEach(async () => {
  await Promise.all(Array.from(activeServers, async (server) => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }));
  activeServers.clear();

  await Promise.all(
    tempDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

function buildBatchStore(batch: Batch): BatchStore {
  return {
    async load() {},
    listSummaries() {
      return [{
        id: batch.id,
        mode: batch.mode,
        title: batch.title,
        status: batch.status,
        createdAt: batch.createdAt,
        startedAt: batch.startedAt,
        completedAt: batch.completedAt,
        cancelRequested: batch.cancelRequested,
        totalRuns: batch.runs.length,
        completedRuns: batch.runs.filter((run) => run.status === "completed").length,
        failedRuns: batch.runs.filter((run) => run.status === "failed").length,
        cancelledRuns: batch.runs.filter((run) => run.status === "cancelled").length,
        preparingRuns: batch.runs.filter((run) => run.status === "preparing").length,
        waitingForCodexRuns: batch.runs.filter((run) => run.status === "waiting_for_codex").length,
        runningRuns: batch.runs.filter((run) => run.status === "running").length,
        queuedRuns: batch.runs.filter((run) => run.status === "queued").length,
        config: batch.config,
        generation: batch.generation,
      }];
    },
    getBatch(batchId) {
      return batchId === batch.id ? batch : null;
    },
    getMutableBatch(batchId) {
      return batchId === batch.id ? batch : null;
    },
    createBatch() {
      throw new Error("Not implemented in tests.");
    },
    updateBatch() {
      return null;
    },
    appendRun() {
      return null;
    },
    updateRun() {
      return null;
    },
    async deleteBatch() {
      return null;
    },
    subscribe() {
      return () => {};
    },
  };
}

function buildBatch(worktreePath: string, runId: string): Batch {
  return {
    id: "batch-test",
    mode: "repeated",
    title: "Test Batch",
    status: "queued",
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: null,
    completedAt: null,
    cancelRequested: false,
    error: null,
    config: {
      runCount: 1,
      concurrency: 1,
      reviewCount: 1,
      projectPath: worktreePath,
      worktreeRoot: worktreePath,
      prompt: "Do work.",
      taskPrompt: "",
      reviewPrompt: "",
      baseRef: "main",
      model: "",
      sandboxMode: "workspace-write",
      networkAccessEnabled: false,
      webSearchMode: "disabled",
      reasoningEffort: "",
    },
    generation: null,
    projectContext: {
      projectPath: worktreePath,
      repoRoot: worktreePath,
      relativeProjectPath: ".",
      headSha: "abc123",
      branchName: "main",
    },
    runs: [{
      id: runId,
      index: 0,
      title: "Run 1",
      prompt: "Do work.",
      status: "queued",
      startedAt: null,
      completedAt: null,
      threadId: null,
      worktreePath,
      workingDirectory: worktreePath,
      baseRef: "main",
      finalResponse: "",
      error: null,
      usage: null,
      logs: [],
      turns: [],
      items: [],
      review: null,
      followUpsReopened: false,
      followUpsReopenedAt: null,
      kind: "candidate",
      score: null,
      rank: null,
      reviewedRunId: null,
    }],
  };
}

function buildServerContext(batch: Batch): ServerContext {
  return {
    projectRoot: "/tmp",
    publicDirectory: "/tmp",
    port: 0,
    store: buildBatchStore(batch),
    settings: {} as ServerContext["settings"],
    modelCatalog: {} as ModelCatalog,
  };
}

async function startMcpServer(context: ServerContext): Promise<string> {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
    const handled = await handleMcpRequest(context, request, response, url);
    if (!handled && !response.writableEnded) {
      response.writeHead(404);
      response.end();
    }
  });

  activeServers.add(server);

  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.on("error", reject);
  });

  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

async function postMcp(baseUrl: string, payload: Record<string, unknown>): Promise<Response> {
  return fetch(`${baseUrl}/mcp/workflow`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "MCP-Protocol-Version": "2025-06-18",
    },
    body: JSON.stringify(payload),
  });
}

async function createTempDirectory(prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join("/tmp", prefix));
  tempDirectories.push(directory);
  return directory;
}

async function createTempRepo(): Promise<string> {
  const repoRoot = await createTempDirectory("agents-runner-mcp-server-");

  await runCommand("git", ["init", "-b", "main", repoRoot]);
  await runCommand("git", ["-C", repoRoot, "config", "user.name", "Agents Runner Tests"]);
  await runCommand("git", ["-C", repoRoot, "config", "user.email", "agents-runner-tests@example.com"]);
  await fs.writeFile(path.join(repoRoot, "README.md"), "initial\n");
  await runCommand("git", ["-C", repoRoot, "add", "README.md"]);
  await runCommand("git", ["-C", repoRoot, "commit", "-m", "initial commit"]);

  return repoRoot;
}

test("initialize returns canonical MCP fields only", async () => {
  const baseUrl = await startMcpServer(buildServerContext(buildBatch(await createTempDirectory("agents-runner-mcp-init-"), "run-1")));
  const response = await postMcp(baseUrl, {
    jsonrpc: "2.0",
    id: "init-1",
    method: "initialize",
    params: {},
  });
  const payload = await response.json() as { result: Record<string, unknown> };

  expect(response.status).toBe(200);
  expect(response.headers.get("mcp-protocol-version")).toBe("2025-06-18");
  expect(payload.result).toHaveProperty("protocolVersion", "2025-06-18");
  expect(payload.result).toHaveProperty("serverInfo");
  expect(payload.result).not.toHaveProperty("protocol_version");
  expect(payload.result).not.toHaveProperty("server_info");
  expect(payload.result).toEqual({
    protocolVersion: "2025-06-18",
    capabilities: {
      tools: {
        listChanged: false,
      },
    },
    serverInfo: {
      name: "agents-runner-workflow",
      version: "0.1.0",
    },
    instructions: "Use create_commit, submit_score, and submit_result in managed worktrees.",
  });
});

test("tools/list returns canonical tool schemas only", async () => {
  const baseUrl = await startMcpServer(buildServerContext(buildBatch(await createTempDirectory("agents-runner-mcp-list-"), "run-1")));
  const response = await postMcp(baseUrl, {
    jsonrpc: "2.0",
    id: "tools-list-1",
    method: "tools/list",
    params: {},
  });
  const payload = await response.json() as { result: { tools: Array<Record<string, unknown>> } };

  expect(response.status).toBe(200);
  expect(payload.result.tools).toHaveLength(3);

  for (const tool of payload.result.tools) {
    expect(tool).toHaveProperty("inputSchema");
    expect(tool).not.toHaveProperty("input_schema");
    expect(tool.annotations).toEqual({
      readOnlyHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
    expect(tool.annotations).not.toHaveProperty("read_only_hint");
    expect(tool.annotations).not.toHaveProperty("idempotent_hint");
    expect(tool.annotations).not.toHaveProperty("open_world_hint");
  }
});

test("create_commit returns a slim canonical tool result", async () => {
  const repoRoot = await createTempRepo();
  await fs.writeFile(path.join(repoRoot, "README.md"), "updated\n");

  const baseUrl = await startMcpServer(buildServerContext(buildBatch(repoRoot, "run-1")));
  const response = await postMcp(baseUrl, {
    jsonrpc: "2.0",
    id: "create-commit-1",
    method: "tools/call",
    params: {
      name: "create_commit",
      arguments: {
        working_folder: repoRoot,
        files: ["README.md"],
        message: "Update readme",
      },
    },
  });
  const payload = await response.json() as { result: Record<string, unknown> };
  const result = payload.result;
  const structured = result.structuredContent as Record<string, unknown>;

  expect(response.status).toBe(200);
  expect(result).not.toHaveProperty("structured_content");
  expect(result).not.toHaveProperty("is_error");
  expect(result).toHaveProperty("isError", false);
  expect(Array.isArray(result.content)).toBe(true);
  expect((result.content as unknown[])).toHaveLength(1);
  expect(structured).toEqual({
    commitSha: expect.any(String),
    branch: "main",
    message: "Update readme",
  });
  expect(structured).not.toHaveProperty("workingFolder");
  expect(structured).not.toHaveProperty("stagedFiles");
  expect(structured).not.toHaveProperty("statSummary");

  const headSubject = await runCommand("git", ["-C", repoRoot, "show", "--format=%s", "--no-patch", "HEAD"]);
  expect(headSubject.stdout.trim()).toBe("Update readme");
});

test("submit_score returns a slim canonical tool result", async () => {
  const worktreePath = await createTempDirectory("agents-runner-mcp-score-");
  const baseUrl = await startMcpServer(buildServerContext(buildBatch(worktreePath, "run-42")));
  const response = await postMcp(baseUrl, {
    jsonrpc: "2.0",
    id: "submit-score-1",
    method: "tools/call",
    params: {
      name: "submit_score",
      arguments: {
        working_folder: worktreePath,
        reviewed_run_id: "run-42",
        score: 88,
        reason: "Looks correct.",
      },
    },
  });
  const payload = await response.json() as { result: Record<string, unknown> };
  const result = payload.result;
  const structured = result.structuredContent as Record<string, unknown>;

  expect(response.status).toBe(200);
  expect(result).not.toHaveProperty("structured_content");
  expect(result).not.toHaveProperty("is_error");
  expect(result).toHaveProperty("isError", false);
  expect(Array.isArray(result.content)).toBe(true);
  expect((result.content as unknown[])).toHaveLength(1);
  expect(structured).toEqual({
    reviewedRunId: "run-42",
    score: 88,
    reason: "Looks correct.",
  });
  expect(structured).not.toHaveProperty("workingFolder");
});

test("submit_result returns a slim canonical tool result", async () => {
  const worktreePath = await createTempDirectory("agents-runner-mcp-result-");
  await fs.mkdir(path.join(worktreePath, "src"));
  await fs.writeFile(path.join(worktreePath, "src", "index.ts"), "export const value = 1;\n");

  const baseUrl = await startMcpServer(buildServerContext(buildBatch(worktreePath, "run-7")));
  const response = await postMcp(baseUrl, {
    jsonrpc: "2.0",
    id: "submit-result-1",
    method: "tools/call",
    params: {
      name: "submit_result",
      arguments: {
        working_folder: worktreePath,
        files: [
          {
            path: "src/index.ts",
            explanation: "Primary entry point.",
          },
        ],
      },
    },
  });
  const payload = await response.json() as { result: Record<string, unknown> };
  const result = payload.result;
  const structured = result.structuredContent as Record<string, unknown>;

  expect(response.status).toBe(200);
  expect(result).not.toHaveProperty("structured_content");
  expect(result).not.toHaveProperty("is_error");
  expect(result).toHaveProperty("isError", false);
  expect(Array.isArray(result.content)).toBe(true);
  expect((result.content as unknown[])).toHaveLength(1);
  expect(structured).toEqual({
    workingFolder: worktreePath,
    runId: "run-7",
    files: [
      {
        path: "src/index.ts",
        explanation: "Primary entry point.",
      },
    ],
  });
});
