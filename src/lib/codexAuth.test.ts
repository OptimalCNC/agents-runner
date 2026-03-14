import { expect, test } from "bun:test";

import { detectCodexAuthStatus, resolveCodexAuthStatus } from "./codexAuth";

function buildIdToken(payload: Record<string, unknown>): string {
  const encode = (value: Record<string, unknown>) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.sig`;
}

test("resolveCodexAuthStatus prefers environment API keys over stored profile auth", () => {
  const status = resolveCodexAuthStatus({
    env: { OPENAI_API_KEY: "sk-test" },
    profile: {
      auth_mode: "chatgpt",
      tokens: {
        id_token: buildIdToken({ email: "person@example.com" }),
      },
    },
  });

  expect(status).toEqual({
    status: "valid",
    source: "apiKey",
    authMode: "api_key",
    accountLabel: null,
    message: "Codex is using OPENAI_API_KEY or CODEX_API_KEY from the environment.",
  });
});

test("resolveCodexAuthStatus extracts the Codex account email from id_token", () => {
  const status = resolveCodexAuthStatus({
    env: {},
    profile: {
      auth_mode: "chatgpt",
      tokens: {
        id_token: buildIdToken({ email: "person@example.com" }),
        access_token: "access-token",
      },
    },
  });

  expect(status).toEqual({
    status: "valid",
    source: "profile",
    authMode: "chatgpt",
    accountLabel: "person@example.com",
    message: "Codex is connected via ChatGPT auth as person@example.com.",
  });
});

test("resolveCodexAuthStatus falls back to account_id when the id_token cannot be decoded", () => {
  const status = resolveCodexAuthStatus({
    env: {},
    profile: {
      auth_mode: "chatgpt",
      tokens: {
        id_token: "not-a-jwt",
        refresh_token: "refresh-token",
        account_id: "account-123",
      },
    },
  });

  expect(status).toEqual({
    status: "valid",
    source: "profile",
    authMode: "chatgpt",
    accountLabel: "account-123",
    message: "Codex is connected via ChatGPT auth as account-123.",
  });
});

test("resolveCodexAuthStatus recognizes api_key auth stored in ~/.codex/auth.json", () => {
  const status = resolveCodexAuthStatus({
    env: {},
    profile: {
      auth_mode: "api_key",
      OPENAI_API_KEY: "sk-file",
    },
  });

  expect(status).toEqual({
    status: "valid",
    source: "apiKey",
    authMode: "api_key",
    accountLabel: null,
    message: "Codex is configured to use an API key stored in ~/.codex/auth.json.",
  });
});

test("detectCodexAuthStatus reports no credentials when ~/.codex/auth.json is missing", async () => {
  const status = await detectCodexAuthStatus({
    env: {},
    readFile: async () => {
      const error = new Error("missing") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    },
  });

  expect(status).toEqual({
    status: "invalid",
    source: "none",
    authMode: null,
    accountLabel: null,
    message: "No Codex credentials detected.",
  });
});
