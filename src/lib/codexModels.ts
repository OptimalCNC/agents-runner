import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import type { CodexAppServerClient, CodexModel, ModelCatalog, ModelCatalogResponse } from "../types";

const APP_SERVER_ARGS = ["app-server", "--listen", "stdio://"];
const APP_SERVER_REQUEST_TIMEOUT_MS = 30_000;
const APP_SERVER_SHUTDOWN_TIMEOUT_MS = 1_000;
const CACHE_TTL_MS = 5 * 60_000;
const INTERNAL_ORIGINATOR_ENV = "CODEX_INTERNAL_ORIGINATOR_OVERRIDE";
const APP_SERVER_ORIGINATOR = "agents_runner";

const PLATFORM_PACKAGE_BY_TARGET: Record<string, string> = {
  "x86_64-unknown-linux-musl": "@openai/codex-linux-x64",
  "aarch64-unknown-linux-musl": "@openai/codex-linux-arm64",
  "x86_64-apple-darwin": "@openai/codex-darwin-x64",
  "aarch64-apple-darwin": "@openai/codex-darwin-arm64",
  "x86_64-pc-windows-msvc": "@openai/codex-win32-x64",
  "aarch64-pc-windows-msvc": "@openai/codex-win32-arm64",
};

const moduleRequire = createRequire(import.meta.url);

interface CacheEntry {
  models: CodexModel[];
  fetchedAtMs: number;
  fetchedAt: string;
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ResolvedBinary {
  binaryPath: string;
  pathEntries: string[];
}

export interface ModelCatalogOptions {
  fetcher?: () => Promise<CodexModel[]>;
  now?: () => number;
  ttlMs?: number;
}

export function createCodexModelCatalog({
  fetcher = fetchCodexModels,
  now = () => Date.now(),
  ttlMs = CACHE_TTL_MS,
}: ModelCatalogOptions = {}): ModelCatalog {
  let cache: CacheEntry | null = null;
  let inFlight: Promise<ModelCatalogResponse> | null = null;

  return {
    async getModels({ refresh = false } = {}) {
      const nowMs = now();
      const hasFreshCache = cache && (nowMs - cache.fetchedAtMs) < ttlMs;

      if (!refresh && hasFreshCache) {
        return buildCatalogResponse(cache!, false);
      }

      if (!inFlight) {
        inFlight = (async () => {
          try {
            const models = await fetcher();
            const fetchedAtMs = now();
            cache = {
              models,
              fetchedAtMs,
              fetchedAt: new Date(fetchedAtMs).toISOString(),
            };
            return buildCatalogResponse(cache, false);
          } catch (error) {
            if (cache) {
              return buildCatalogResponse(cache, true);
            }

            throw wrapModelLoadError(error);
          } finally {
            inFlight = null;
          }
        })();
      }

      return inFlight;
    },
  };
}

export interface FetchCodexModelsOptions {
  clientFactory?: () => Promise<CodexAppServerClient>;
}

export async function fetchCodexModels({
  clientFactory = () => Promise.resolve(createCodexAppServerClient()),
}: FetchCodexModelsOptions = {}): Promise<CodexModel[]> {
  const client = await clientFactory();

  try {
    await client.request("initialize", {
      clientInfo: {
        name: "agents-runner",
        version: "0.1.0",
      },
    });

    const models: CodexModel[] = [];
    let cursor: string | null = null;

    do {
      const response = await client.request("model/list", cursor ? { cursor } : {}) as Record<string, unknown>;
      const page = Array.isArray(response?.data) ? response.data : [];

      for (const model of page) {
        const normalized = normalizeModel(model);
        if (!normalized.hidden) {
          models.push(normalized);
        }
      }

      cursor = typeof response?.nextCursor === "string" && response.nextCursor
        ? response.nextCursor as string
        : null;
    } while (cursor);

    return models;
  } catch (error) {
    throw wrapModelLoadError(error);
  } finally {
    await client.close();
  }
}

export function createCodexAppServerClient(options: {
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
} = {}): CodexAppServerClient {
  if (typeof Bun !== "undefined" && typeof Bun.spawn === "function") {
    return createBunCodexAppServerClient(options);
  }

  return createNodeCodexAppServerClient(options);
}

function createBunCodexAppServerClient({
  env = process.env,
  requestTimeoutMs = APP_SERVER_REQUEST_TIMEOUT_MS,
}: {
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
} = {}): CodexAppServerClient {
  const { binaryPath, pathEntries } = resolveCodexBinary();
  const child = Bun.spawn([binaryPath, ...APP_SERVER_ARGS], {
    env: buildCodexEnvironment(env, pathEntries),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  const pendingRequests = new Map<string, PendingRequest>();
  let stdoutBuffer = "";
  let stderrBuffer = "";
  let nextRequestId = 0;
  let closed = false;
  let fatalError: Error | null = null;

  function rejectPendingRequests(error: unknown): void {
    const normalizedError = normalizeError(error);
    fatalError = fatalError || normalizedError;

    for (const entry of pendingRequests.values()) {
      clearTimeout(entry.timer);
      entry.reject(fatalError);
    }

    pendingRequests.clear();
  }

  function handleStdoutLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    let message: Record<string, unknown>;
    try {
      message = JSON.parse(trimmed);
    } catch (error) {
      rejectPendingRequests(new Error(`Failed to parse Codex app-server output: ${trimmed}`, { cause: error }));
      return;
    }

    if (message.id === undefined) {
      return;
    }

    const requestId = String(message.id);
    const pending = pendingRequests.get(requestId);
    if (!pending) {
      return;
    }

    pendingRequests.delete(requestId);
    clearTimeout(pending.timer);

    if (message.error) {
      const errObj = message.error as Record<string, unknown>;
      pending.reject(new Error((errObj.message as string) || `Codex app-server request failed: ${pending.method}`));
      return;
    }

    pending.resolve(message.result);
  }

  function handleStdoutChunk(text: string): void {
    stdoutBuffer += text;

    while (true) {
      const newlineIndex = stdoutBuffer.indexOf("\n");
      if (newlineIndex < 0) {
        break;
      }

      const line = stdoutBuffer.slice(0, newlineIndex);
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      handleStdoutLine(line);
    }
  }

  const stdoutPump = pumpReadableStream(
    child.stdout.getReader(),
    (text: string) => {
      handleStdoutChunk(text);
    },
    (error: unknown) => {
      if (!closed) {
        rejectPendingRequests(new Error(`Codex app-server stream failed: ${normalizeError(error).message}`));
      }
    },
  );

  const stderrPump = pumpReadableStream(
    child.stderr.getReader(),
    (text: string) => {
      stderrBuffer += text;
    },
    () => {},
  );

  const exitPromise = child.exited.then((code: number) => {
    if (!closed && (code !== 0 || pendingRequests.size > 0)) {
      const stderrText = stderrBuffer.trim();
      rejectPendingRequests(
        new Error(
          stderrText
            ? `Codex app-server exited with code ${code}: ${stderrText}`
            : `Codex app-server exited with code ${code}.`,
        ),
      );
    }
    return code;
  });

  function request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (fatalError) {
      return Promise.reject(fatalError);
    }

    const requestId = String(++nextRequestId);
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id: requestId,
      method,
      params,
    });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingRequests.delete(requestId);
        reject(new Error(`Codex app-server request timed out: ${method}`));
        void close();
      }, requestTimeoutMs);

      pendingRequests.set(requestId, { method, resolve, reject, timer });

      try {
        child.stdin.write(`${payload}\n`);
      } catch (error) {
        pendingRequests.delete(requestId);
        clearTimeout(timer);
        reject(new Error(`Failed to send Codex app-server request: ${normalizeError(error).message}`));
      }
    });
  }

  async function close(): Promise<void> {
    if (closed) {
      await exitPromise;
      return;
    }

    closed = true;

    for (const entry of pendingRequests.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("Codex app-server closed."));
    }
    pendingRequests.clear();

    try {
      child.stdin.end();
    } catch {
      // ignore
    }

    try {
      child.kill();
    } catch {
      // ignore
    }

    const exited = await Promise.race([
      exitPromise.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), APP_SERVER_SHUTDOWN_TIMEOUT_MS)),
    ]);

    if (!exited) {
      try {
        child.kill();
      } catch {
        // ignore
      }
      await exitPromise;
    }

    await Promise.allSettled([stdoutPump, stderrPump]);
  }

  return { request, close };
}

function createNodeCodexAppServerClient({
  spawnImpl = spawn,
  env = process.env,
  requestTimeoutMs = APP_SERVER_REQUEST_TIMEOUT_MS,
}: {
  spawnImpl?: typeof spawn;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
} = {}): CodexAppServerClient {
  const { binaryPath, pathEntries } = resolveCodexBinary();
  const child = spawnImpl(binaryPath, APP_SERVER_ARGS, {
    env: buildCodexEnvironment(env, pathEntries),
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (!child.stdin || !child.stdout) {
    try {
      child.kill();
    } catch {
      // ignore
    }
    throw new Error("Codex app-server pipes are unavailable.");
  }

  const pendingRequests = new Map<string, PendingRequest>();
  const stderrChunks: Buffer[] = [];
  let stdoutBuffer = "";

  let nextRequestId = 0;
  let closed = false;
  let fatalError: Error | null = null;
  let resolveExit: () => void;
  const exitPromise = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });

  function rejectPendingRequests(error: unknown): void {
    const normalizedError = normalizeError(error);
    fatalError = fatalError || normalizedError;

    for (const entry of pendingRequests.values()) {
      clearTimeout(entry.timer);
      entry.reject(fatalError);
    }

    pendingRequests.clear();
  }

  function formatFailure(code: number | null, signal: string | null): string {
    const detail = signal ? `signal ${signal}` : `code ${code ?? 1}`;
    const stderrText = getProcessStderr(stderrChunks);
    return stderrText
      ? `Codex app-server exited with ${detail}: ${stderrText}`
      : `Codex app-server exited with ${detail}.`;
  }

  child.stderr?.on("data", (chunk: Buffer) => {
    stderrChunks.push(Buffer.from(chunk));
  });

  child.once("error", (error: Error) => {
    if (!closed) {
      rejectPendingRequests(error);
    }
  });

  child.once("exit", (code: number | null, signal: string | null) => {
    if (!closed && (code !== 0 || signal || pendingRequests.size > 0)) {
      rejectPendingRequests(new Error(formatFailure(code, signal)));
    }
    resolveExit();
  });

  function handleStdoutLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    let message: Record<string, unknown>;
    try {
      message = JSON.parse(trimmed);
    } catch (error) {
      rejectPendingRequests(new Error(`Failed to parse Codex app-server output: ${trimmed}`, { cause: error }));
      return;
    }

    if (message.id === undefined) {
      return;
    }

    const requestId = String(message.id);
    const pending = pendingRequests.get(requestId);
    if (!pending) {
      return;
    }

    pendingRequests.delete(requestId);
    clearTimeout(pending.timer);

    if (message.error) {
      const errObj = message.error as Record<string, unknown>;
      pending.reject(new Error((errObj.message as string) || `Codex app-server request failed: ${pending.method}`));
      return;
    }

    pending.resolve(message.result);
  }

  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBuffer += chunk.toString();

    while (true) {
      const newlineIndex = stdoutBuffer.indexOf("\n");
      if (newlineIndex < 0) {
        break;
      }

      const line = stdoutBuffer.slice(0, newlineIndex);
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      handleStdoutLine(line);
    }
  });

  child.stdout.on("error", (error: Error) => {
    if (!closed) {
      rejectPendingRequests(new Error(`Codex app-server stream failed: ${normalizeError(error).message}`));
    }
  });

  child.stdout.on("end", () => {
    if (stdoutBuffer.trim()) {
      handleStdoutLine(stdoutBuffer);
      stdoutBuffer = "";
    }
  });

  function request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (fatalError) {
      return Promise.reject(fatalError);
    }

    const requestId = String(++nextRequestId);
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id: requestId,
      method,
      params,
    });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingRequests.delete(requestId);
        reject(new Error(`Codex app-server request timed out: ${method}`));
        void close();
      }, requestTimeoutMs);

      pendingRequests.set(requestId, { method, resolve, reject, timer });

      child.stdin!.write(`${payload}\n`, (error?: Error | null) => {
        if (!error) {
          return;
        }

        const pending = pendingRequests.get(requestId);
        if (!pending) {
          return;
        }

        pendingRequests.delete(requestId);
        clearTimeout(timer);
        pending.reject(new Error(`Failed to send Codex app-server request: ${error.message}`));
      });
    });
  }

  async function close(): Promise<void> {
    if (closed) {
      await exitPromise;
      return;
    }

    closed = true;

    for (const entry of pendingRequests.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("Codex app-server closed."));
    }
    pendingRequests.clear();

    try {
      child.stdin!.end();
    } catch {
      // ignore
    }

    try {
      if (!child.killed) {
        child.kill("SIGTERM");
      }
    } catch {
      // ignore
    }

    const exited = await Promise.race([
      exitPromise.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), APP_SERVER_SHUTDOWN_TIMEOUT_MS)),
    ]);

    if (!exited) {
      try {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
      } catch {
        // ignore
      }
      await exitPromise;
    }

  }

  return { request, close };
}

function buildCatalogResponse(cacheEntry: CacheEntry, stale: boolean): ModelCatalogResponse {
  return {
    models: cacheEntry.models,
    fetchedAt: cacheEntry.fetchedAt,
    stale,
  };
}

function normalizeModel(rawModel: Record<string, unknown>): CodexModel {
  const supportedReasoningEfforts = Array.isArray(rawModel?.supportedReasoningEfforts)
    ? (rawModel.supportedReasoningEfforts as Record<string, unknown>[])
        .map((entry) => ({
          reasoningEffort: String(entry?.reasoningEffort || ""),
          description: String(entry?.description || ""),
        }))
        .filter((entry) => entry.reasoningEffort)
    : [];

  return {
    model: String(rawModel?.model || rawModel?.id || ""),
    displayName: String(rawModel?.displayName || rawModel?.model || rawModel?.id || ""),
    description: String(rawModel?.description || ""),
    isDefault: Boolean(rawModel?.isDefault),
    defaultReasoningEffort: String(rawModel?.defaultReasoningEffort || ""),
    supportedReasoningEfforts,
    hidden: Boolean(rawModel?.hidden),
    upgrade: (rawModel?.upgrade as string) ?? null,
    upgradeInfo: rawModel?.upgradeInfo
      ? {
          model: String((rawModel.upgradeInfo as Record<string, unknown>).model || ""),
          migrationMarkdown: ((rawModel.upgradeInfo as Record<string, unknown>).migrationMarkdown as string) ?? null,
          modelLink: ((rawModel.upgradeInfo as Record<string, unknown>).modelLink as string) ?? null,
          upgradeCopy: ((rawModel.upgradeInfo as Record<string, unknown>).upgradeCopy as string) ?? null,
        }
      : null,
    availabilityNux: rawModel?.availabilityNux
      ? { message: String((rawModel.availabilityNux as Record<string, unknown>).message || "") }
      : null,
  };
}

function resolveCodexBinary({
  platform = process.platform,
  arch = process.arch,
}: {
  platform?: string;
  arch?: string;
} = {}): ResolvedBinary {
  const targetTriple = getTargetTriple(platform, arch);
  const packageName = PLATFORM_PACKAGE_BY_TARGET[targetTriple];

  if (!packageName) {
    throw new Error(`Unsupported target triple: ${targetTriple}`);
  }

  let vendorRoot: string;
  try {
    const packageJsonPath = moduleRequire.resolve(`${packageName}/package.json`);
    vendorRoot = path.join(path.dirname(packageJsonPath), "vendor");
  } catch {
    throw new Error(
      `Missing optional dependency ${packageName}. Reinstall @openai/codex with optional platform binaries.`,
    );
  }

  const archRoot = path.join(vendorRoot, targetTriple);
  const binaryName = platform === "win32" ? "codex.exe" : "codex";
  const binaryPath = path.join(archRoot, "codex", binaryName);

  if (!existsSync(binaryPath)) {
    throw new Error(`Codex binary not found at ${binaryPath}`);
  }

  const pathDir = path.join(archRoot, "path");
  return {
    binaryPath,
    pathEntries: existsSync(pathDir) ? [pathDir] : [],
  };
}

function buildCodexEnvironment(baseEnv: NodeJS.ProcessEnv, pathEntries: string[]): NodeJS.ProcessEnv {
  const env = { ...baseEnv };
  const pathSeparator = process.platform === "win32" ? ";" : ":";
  const existingPath = env.PATH || "";
  const nextPathEntries = [...pathEntries, ...existingPath.split(pathSeparator).filter(Boolean)];

  env.PATH = nextPathEntries.join(pathSeparator);

  if (!env[INTERNAL_ORIGINATOR_ENV]) {
    env[INTERNAL_ORIGINATOR_ENV] = APP_SERVER_ORIGINATOR;
  }

  return env;
}

function getTargetTriple(platform: string, arch: string): string {
  if (platform === "linux" || platform === "android") {
    if (arch === "x64") return "x86_64-unknown-linux-musl";
    if (arch === "arm64") return "aarch64-unknown-linux-musl";
  }

  if (platform === "darwin") {
    if (arch === "x64") return "x86_64-apple-darwin";
    if (arch === "arm64") return "aarch64-apple-darwin";
  }

  if (platform === "win32") {
    if (arch === "x64") return "x86_64-pc-windows-msvc";
    if (arch === "arm64") return "aarch64-pc-windows-msvc";
  }

  throw new Error(`Unsupported platform: ${platform} (${arch})`);
}

function getProcessStderr(chunks: Buffer[]): string {
  if (chunks.length === 0) {
    return "";
  }

  return Buffer.concat(chunks).toString("utf8").trim();
}

function wrapModelLoadError(error: unknown): Error {
  const message = normalizeError(error).message;
  if (message.startsWith("Unable to load models from Codex:")) {
    return new Error(message);
  }
  return new Error(`Unable to load models from Codex: ${message}`);
}

async function pumpReadableStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onChunk: (text: string) => void,
  onError: (error: unknown) => void,
): Promise<void> {
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      onChunk(decoder.decode(value, { stream: true }));
    }

    const tail = decoder.decode();
    if (tail) {
      onChunk(tail);
    }
  } catch (error) {
    onError(error);
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error ?? "Unknown error"));
}
