import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildCodexEnvironment, resolveCodexBinary } from "./codexModels";
import { runCommand } from "./process";

import type { BundledMcpStatus, BundledMcpTransport } from "../types";

const MCP_SERVER_NAME = "agents-runner-git";
const MCP_ENDPOINT_PATH = "/mcp/git";

interface McpServerConfigEntry {
  url: string | null;
  transport: BundledMcpTransport | null;
}

interface CodexMcpOptions {
  env?: NodeJS.ProcessEnv;
  runner?: typeof runCommand;
}

function getBaseEnv(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...process.env, ...(env || {}) };
}

export function getCodexHomeDirectory(env?: NodeJS.ProcessEnv): string {
  const baseEnv = getBaseEnv(env);
  const configuredHome = String(baseEnv.CODEX_HOME ?? "").trim();
  return configuredHome ? path.resolve(configuredHome) : path.join(os.homedir(), ".codex");
}

export function getCodexConfigPath(env?: NodeJS.ProcessEnv): string {
  return path.join(getCodexHomeDirectory(env), "config.toml");
}

export function buildBundledMcpEndpointUrl(port: number): string {
  return `http://127.0.0.1:${port}${MCP_ENDPOINT_PATH}`;
}

async function readCodexConfig(env?: NodeJS.ProcessEnv): Promise<Record<string, unknown>> {
  const configPath = getCodexConfigPath(env);

  try {
    const content = await fs.readFile(configPath, "utf8");
    return Bun.TOML.parse(content) as Record<string, unknown>;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return {};
    }

    throw new Error(`Failed to read ${configPath}: ${(error as Error).message}`);
  }
}

function readBundledMcpConfigEntry(config: Record<string, unknown>): McpServerConfigEntry | null {
  const servers = config.mcp_servers;
  if (!servers || typeof servers !== "object") {
    return null;
  }

  const entry = (servers as Record<string, unknown>)[MCP_SERVER_NAME];
  if (!entry || typeof entry !== "object") {
    return null;
  }

  const url = typeof (entry as Record<string, unknown>).url === "string"
    ? String((entry as Record<string, unknown>).url).trim()
    : "";
  const transport: BundledMcpTransport | null = url ? "streamable_http" : "stdio";

  return {
    url: url || null,
    transport,
  };
}

export async function getBundledMcpStatus(port: number, options: CodexMcpOptions = {}): Promise<BundledMcpStatus> {
  const endpointUrl = buildBundledMcpEndpointUrl(port);
  const configPath = getCodexConfigPath(options.env);
  const config = await readCodexConfig(options.env);
  const entry = readBundledMcpConfigEntry(config);
  const installed = Boolean(entry);
  const healthy = Boolean(entry?.url && entry.url === endpointUrl);

  let error = "";
  if (installed && !healthy) {
    if (!entry?.url) {
      error = "Codex has this MCP server name configured, but it is not using the expected HTTP transport.";
    } else {
      error = `Codex is configured to use ${entry.url}, but Agents Runner expects ${endpointUrl}.`;
    }
  }

  return {
    serverName: MCP_SERVER_NAME,
    endpointPath: MCP_ENDPOINT_PATH,
    endpointUrl,
    configPath,
    installed,
    healthy,
    transport: entry?.transport ?? null,
    configuredUrl: entry?.url ?? null,
    error,
  };
}

function buildCodexCliEnv(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const baseEnv = getBaseEnv(env);
  const { pathEntries } = resolveCodexBinary();
  return buildCodexEnvironment(baseEnv, pathEntries);
}

function buildCodexCliCommandArgs(endpointUrl: string): string[] {
  return ["mcp", "add", MCP_SERVER_NAME, "--url", endpointUrl];
}

export async function installBundledMcpServer(port: number, options: CodexMcpOptions = {}): Promise<BundledMcpStatus> {
  const status = await getBundledMcpStatus(port, options);
  if (status.healthy) {
    return status;
  }

  const runner = options.runner || runCommand;
  const { binaryPath } = resolveCodexBinary();
  const env = buildCodexCliEnv(options.env);

  const removeResult = await runner(binaryPath, ["mcp", "remove", MCP_SERVER_NAME], {
    env,
    allowFailure: true,
  });
  const removeText = `${removeResult.stdout}\n${removeResult.stderr}`.trim();
  if (removeResult.code !== 0 && !/No MCP server named/i.test(removeText)) {
    throw new Error(removeText || `Failed to remove existing MCP server ${MCP_SERVER_NAME}.`);
  }

  await runner(binaryPath, buildCodexCliCommandArgs(status.endpointUrl), { env });

  const verified = await getBundledMcpStatus(port, options);
  if (!verified.healthy) {
    throw new Error(verified.error || "MCP install completed, but Codex did not report the expected server configuration.");
  }

  return verified;
}
