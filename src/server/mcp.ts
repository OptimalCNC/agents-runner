import type { IncomingMessage, ServerResponse } from "node:http";

import {
  createManagedWorktreeCommit,
  collectManagedWorktrees,
  negotiateMcpProtocolVersion,
} from "../lib/mcpGit";
import { submitManagedRunScore } from "../lib/mcpReview";

import type { ServerContext } from "./context";

const JSON_RPC_VERSION = "2.0";
const MCP_SERVER_NAME = "agents-runner-workflow";
const MCP_TOOL_NAME_CREATE_COMMIT = "create_commit";
const MCP_TOOL_NAME_SUBMIT_SCORE = "submit_score";
const MCP_SESSION_HEADER = "mcp-session-id";
const MCP_PROTOCOL_HEADER = "mcp-protocol-version";
const MCP_SERVER_VERSION = "0.1.0";
const MCP_KEEPALIVE_INTERVAL_MS = 15_000;

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

function createSessionId(): string {
  return `agents-runner-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function sendMcpJson(
  response: ServerResponse,
  statusCode: number,
  payload: unknown,
  options: { protocolVersion: string; sessionId?: string } | { protocolVersion?: string; sessionId?: string } = {},
): void {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...(options.protocolVersion ? { "MCP-Protocol-Version": options.protocolVersion } : {}),
    ...(options.sessionId ? { "Mcp-Session-Id": options.sessionId } : {}),
  });
  response.end(`${JSON.stringify(payload)}\n`);
}

function sendJsonRpcResult(
  response: ServerResponse,
  id: unknown,
  result: unknown,
  protocolVersion: string,
  sessionId?: string,
): void {
  sendMcpJson(response, 200, {
    jsonrpc: JSON_RPC_VERSION,
    id,
    result,
  }, { protocolVersion, sessionId });
}

function sendJsonRpcError(
  response: ServerResponse,
  id: unknown,
  error: { code: number; message: string; data?: unknown },
  protocolVersion: string,
  sessionId?: string,
  statusCode: number = 200,
): void {
  sendMcpJson(response, statusCode, {
    jsonrpc: JSON_RPC_VERSION,
    id,
    error,
  }, { protocolVersion, sessionId });
}

function buildCreateCommitToolDefinition(): Record<string, unknown> {
  const inputSchema = {
    type: "object",
    additionalProperties: false,
    required: ["working_folder", "files", "message"],
    properties: {
      working_folder: {
        type: "string",
        minLength: 1,
        description: "Absolute path to the run worktree root returned by git rev-parse --show-toplevel.",
      },
      files: {
        type: "array",
        minItems: 1,
        items: {
          type: "string",
          minLength: 1,
        },
        description: "File paths inside the selected worktree to stage for this commit.",
      },
      message: {
        type: "string",
        minLength: 1,
        description: "Commit message to use for the single commit.",
      },
    },
  };

  return {
    name: MCP_TOOL_NAME_CREATE_COMMIT,
    title: "Create Commit",
    description: "Stage only the selected files in a managed Agents Runner worktree and create a single git commit.",
    inputSchema,
    input_schema: inputSchema,
    annotations: {
      readOnlyHint: false,
      read_only_hint: false,
      idempotentHint: false,
      idempotent_hint: false,
      openWorldHint: false,
      open_world_hint: false,
    },
  };
}



function buildSubmitScoreToolDefinition(): Record<string, unknown> {
  const inputSchema = {
    type: "object",
    additionalProperties: false,
    required: ["working_folder", "reviewed_run_id", "score", "reason"],
    properties: {
      working_folder: {
        type: "string",
        minLength: 1,
        description: "Absolute path to the reviewed run worktree root returned by git rev-parse --show-toplevel.",
      },
      reviewed_run_id: {
        type: "string",
        minLength: 1,
        description: "Run id being reviewed (for example run-1).",
      },
      score: {
        type: "number",
        minimum: 0,
        maximum: 100,
        description: "Numeric score for the reviewed run.",
      },
      reason: {
        type: "string",
        minLength: 1,
        description: "Concise reason for the score.",
      },
    },
  };

  return {
    name: MCP_TOOL_NAME_SUBMIT_SCORE,
    title: "Submit Score",
    description: "Submit a reviewer score for exactly one managed Agents Runner run.",
    inputSchema,
    input_schema: inputSchema,
    annotations: {
      readOnlyHint: false,
      read_only_hint: false,
      idempotentHint: false,
      idempotent_hint: false,
      openWorldHint: false,
      open_world_hint: false,
    },
  };
}

function buildInitializeResult(protocolVersion: string): Record<string, unknown> {
  const serverInfo = {
    name: MCP_SERVER_NAME,
    version: MCP_SERVER_VERSION,
  };
  const capabilities = {
    tools: {
      listChanged: false,
      list_changed: false,
    },
  };

  return {
    protocolVersion,
    protocol_version: protocolVersion,
    capabilities,
    serverInfo,
    server_info: serverInfo,
    instructions: "Use create_commit for candidate commits and submit_score for reviewer scoring in managed Agents Runner worktrees.",
  };
}

function buildCreateCommitToolResult(result: Awaited<ReturnType<typeof createManagedWorktreeCommit>>): Record<string, unknown> {
  const branchLabel = result.branch || "(detached)";
  const summaryLine = result.statSummary || `Staged files: ${result.stagedFiles.join(", ")}`;

  return {
    content: [
      {
        type: "text",
        text: `Created commit ${result.commitSha} on ${branchLabel}: ${result.message}`,
      },
      {
        type: "text",
        text: summaryLine,
      },
    ],
    structuredContent: result,
    structured_content: result,
    isError: false,
    is_error: false,
  };
}



function buildSubmitScoreToolResult(result: Awaited<ReturnType<typeof submitManagedRunScore>>): Record<string, unknown> {
  return {
    content: [
      {
        type: "text",
        text: `Submitted score ${result.score} for ${result.reviewedRunId}.`,
      },
      {
        type: "text",
        text: result.reason,
      },
    ],
    structuredContent: result,
    structured_content: result,
    isError: false,
    is_error: false,
  };
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    let body = "";

    request.on("data", (chunk: Buffer) => {
      body += chunk.toString();
      if (body.length > 1_000_000) {
        reject(new Error("Request body too large."));
        request.destroy();
      }
    });

    request.on("end", () => {
      if (!body.trim()) {
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

function getStringHeader(request: IncomingMessage, name: string): string {
  const value = request.headers[name];
  return Array.isArray(value) ? String(value[0] ?? "").trim() : String(value ?? "").trim();
}

function handleSseRequest(request: IncomingMessage, response: ServerResponse): void {
  const sessionId = getStringHeader(request, MCP_SESSION_HEADER) || createSessionId();
  const protocolVersion = negotiateMcpProtocolVersion(getStringHeader(request, MCP_PROTOCOL_HEADER));

  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "MCP-Protocol-Version": protocolVersion,
    "Mcp-Session-Id": sessionId,
  });
  response.write(": connected\n\n");

  const keepalive = setInterval(() => {
    if (!response.writableEnded) {
      response.write(": keepalive\n\n");
    }
  }, MCP_KEEPALIVE_INTERVAL_MS);

  request.on("close", () => {
    clearInterval(keepalive);
    if (!response.writableEnded) {
      response.end();
    }
  });
}

function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export async function handleMcpRequest(
  context: ServerContext,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (url.pathname !== "/mcp/workflow") {
    return false;
  }

  if (request.method === "GET") {
    handleSseRequest(request, response);
    return true;
  }

  if (request.method === "DELETE") {
    response.writeHead(204, { "Cache-Control": "no-store" });
    response.end();
    return true;
  }

  if (request.method !== "POST") {
    response.writeHead(405, { Allow: "GET, POST, DELETE" });
    response.end();
    return true;
  }

  const protocolVersion = negotiateMcpProtocolVersion(getStringHeader(request, MCP_PROTOCOL_HEADER));
  const sessionId = getStringHeader(request, MCP_SESSION_HEADER) || createSessionId();

  let payload: unknown;
  try {
    payload = await readJsonBody(request);
  } catch (error) {
    sendJsonRpcError(
      response,
      null,
      { code: -32700, message: (error as Error).message || "Invalid JSON payload." },
      protocolVersion,
      sessionId,
      400,
    );
    return true;
  }

  if (!isJsonRpcRequest(payload) || payload.jsonrpc !== JSON_RPC_VERSION || typeof payload.method !== "string") {
    sendJsonRpcError(
      response,
      isJsonRpcRequest(payload) ? payload.id ?? null : null,
      { code: -32600, message: "Invalid JSON-RPC request." },
      protocolVersion,
      sessionId,
      400,
    );
    return true;
  }

  const id = Object.prototype.hasOwnProperty.call(payload, "id") ? payload.id : undefined;
  const { method, params } = payload;

  if (typeof id === "undefined") {
    response.writeHead(202, {
      "Cache-Control": "no-store",
      "MCP-Protocol-Version": protocolVersion,
      "Mcp-Session-Id": sessionId,
    });
    response.end();
    return true;
  }

  try {
    switch (method) {
      case "initialize":
        sendJsonRpcResult(response, id, buildInitializeResult(protocolVersion), protocolVersion, sessionId);
        return true;
      case "ping":
        sendJsonRpcResult(response, id, {}, protocolVersion, sessionId);
        return true;
      case "tools/list":
        sendJsonRpcResult(response, id, { tools: [buildCreateCommitToolDefinition(), buildSubmitScoreToolDefinition()] }, protocolVersion, sessionId);
        return true;
      case "tools/call": {
        const callParams = (params && typeof params === "object") ? params as Record<string, unknown> : {};
        const toolName = String(callParams.name ?? "").trim();
        if (!toolName) {
          sendJsonRpcError(
            response,
            id,
            { code: -32602, message: "Tool name is required." },
            protocolVersion,
            sessionId,
          );
          return true;
        }

        const managedWorktrees = await collectManagedWorktrees(context.store);

        if (toolName === MCP_TOOL_NAME_CREATE_COMMIT) {
          const result = await createManagedWorktreeCommit(managedWorktrees, callParams.arguments);
          sendJsonRpcResult(response, id, buildCreateCommitToolResult(result), protocolVersion, sessionId);
          return true;
        }

        if (toolName === MCP_TOOL_NAME_SUBMIT_SCORE) {
          const result = await submitManagedRunScore(managedWorktrees, callParams.arguments);
          sendJsonRpcResult(response, id, buildSubmitScoreToolResult(result), protocolVersion, sessionId);
          return true;
        }

        sendJsonRpcError(
          response,
          id,
          { code: -32602, message: `Unknown tool ${toolName}.` },
          protocolVersion,
          sessionId,
        );
        return true;
      }
      default:
        sendJsonRpcError(response, id, { code: -32601, message: `Method ${method} not found.` }, protocolVersion, sessionId);
        return true;
    }
  } catch (error) {
    sendJsonRpcError(
      response,
      id,
      { code: -32000, message: (error as Error).message || "MCP tool call failed." },
      protocolVersion,
      sessionId,
    );
    return true;
  }
}
