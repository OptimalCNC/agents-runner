import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { CodexAuthValidationResponse } from "../types";

const DEFAULT_AUTH_PATH = path.join(os.homedir(), ".codex", "auth.json");

type CodexAuthStatusPayload = Omit<CodexAuthValidationResponse, "checkedAt">;

interface CodexAuthFile {
  auth_mode?: unknown;
  OPENAI_API_KEY?: unknown;
  email?: unknown;
  user?: unknown;
  tokens?: {
    id_token?: unknown;
    access_token?: unknown;
    refresh_token?: unknown;
    account_id?: unknown;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface DetectCodexAuthStatusOptions {
  env?: NodeJS.ProcessEnv;
  authPath?: string;
  readFile?: (targetPath: string, encoding: BufferEncoding) => Promise<string>;
}

export async function detectCodexAuthStatus({
  env = process.env,
  authPath = DEFAULT_AUTH_PATH,
  readFile = (targetPath, encoding) => fsp.readFile(targetPath, encoding),
}: DetectCodexAuthStatusOptions = {}): Promise<CodexAuthStatusPayload> {
  if (hasEnvironmentApiKey(env)) {
    return {
      status: "valid",
      source: "apiKey",
      authMode: "api_key",
      accountLabel: null,
      message: "Codex is using OPENAI_API_KEY or CODEX_API_KEY from the environment.",
    };
  }

  try {
    const profile = JSON.parse(await readFile(authPath, "utf8")) as CodexAuthFile;
    return resolveCodexAuthStatus({ env, profile });
  } catch (error) {
    const readError = error as NodeJS.ErrnoException;
    if (readError.code === "ENOENT") {
      return {
        status: "invalid",
        source: "none",
        authMode: null,
        accountLabel: null,
        message: "No Codex credentials detected.",
      };
    }

    return {
      status: "invalid",
      source: "profile",
      authMode: null,
      accountLabel: null,
      message: `Failed to read ~/.codex/auth.json: ${readError.message || "unknown error"}`,
    };
  }
}

export function resolveCodexAuthStatus({
  env = process.env,
  profile,
}: {
  env?: NodeJS.ProcessEnv;
  profile?: unknown;
} = {}): CodexAuthStatusPayload {
  if (hasEnvironmentApiKey(env)) {
    return {
      status: "valid",
      source: "apiKey",
      authMode: "api_key",
      accountLabel: null,
      message: "Codex is using OPENAI_API_KEY or CODEX_API_KEY from the environment.",
    };
  }

  const auth = isRecord(profile) ? profile as CodexAuthFile : {};
  const authMode = getTrimmedString(auth.auth_mode);
  const tokens = isRecord(auth.tokens) ? auth.tokens : {};
  const idToken = getTrimmedString(tokens.id_token);
  const accessToken = getTrimmedString(tokens.access_token);
  const refreshToken = getTrimmedString(tokens.refresh_token);
  const storedApiKey = getTrimmedString(auth.OPENAI_API_KEY);

  if (idToken || accessToken || refreshToken) {
    const accountLabel = getProfileAccountLabel({ auth, tokens, idToken });
    const authFlavor = authMode === "chatgpt" ? "ChatGPT auth" : "stored Codex auth";

    return {
      status: "valid",
      source: "profile",
      authMode,
      accountLabel,
      message: accountLabel
        ? `Codex is connected via ${authFlavor} as ${accountLabel}.`
        : `Codex is connected via ${authFlavor}.`,
    };
  }

  if (storedApiKey) {
    return {
      status: "valid",
      source: "apiKey",
      authMode: authMode || "api_key",
      accountLabel: null,
      message: "Codex is configured to use an API key stored in ~/.codex/auth.json.",
    };
  }

  return {
    status: "invalid",
    source: "profile",
    authMode,
    accountLabel: null,
    message: "~/.codex/auth.json exists but does not contain usable Codex credentials.",
  };
}

function hasEnvironmentApiKey(env: NodeJS.ProcessEnv): boolean {
  return Boolean(getTrimmedString(env.OPENAI_API_KEY) || getTrimmedString(env.CODEX_API_KEY));
}

function getProfileAccountLabel({
  auth,
  tokens,
  idToken,
}: {
  auth: CodexAuthFile;
  tokens: Record<string, unknown>;
  idToken: string | null;
}): string | null {
  const jwtPayload = idToken ? decodeJwtPayload(idToken) : null;

  return getTrimmedString(jwtPayload?.email)
    || getTrimmedString(jwtPayload?.user)
    || getTrimmedString(jwtPayload?.preferred_username)
    || getTrimmedString(jwtPayload?.name)
    || getTrimmedString(auth.email)
    || getTrimmedString(auth.user)
    || getTrimmedString(tokens.account_id)
    || null;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const [, payload = ""] = token.split(".");
  if (!payload) return null;

  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized ? normalized : null;
}
