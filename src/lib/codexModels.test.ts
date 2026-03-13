import { expect, test } from "bun:test";

import { createCodexModelCatalog, fetchCodexModels } from "./codexModels";

import type { CodexModel, CodexAppServerClient } from "../types";

interface RawModel {
  id: string;
  model: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  hidden: boolean;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: Array<{ reasoningEffort: string; description: string }>;
  upgrade: string | null;
  upgradeInfo: null;
  availabilityNux: null;
}

function buildRawModel(overrides: Partial<RawModel> = {}): RawModel {
  return {
    id: "gpt-5.4",
    model: "gpt-5.4",
    displayName: "gpt-5.4",
    description: "Latest frontier agentic coding model.",
    isDefault: false,
    hidden: false,
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: [
      { reasoningEffort: "low", description: "Fast responses" },
      { reasoningEffort: "medium", description: "Balanced reasoning" },
    ],
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    ...overrides,
  };
}

function buildExpectedModel(overrides: Partial<CodexModel> = {}): CodexModel {
  return {
    model: "gpt-5.4",
    displayName: "gpt-5.4",
    description: "Latest frontier agentic coding model.",
    isDefault: false,
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: [
      { reasoningEffort: "low", description: "Fast responses" },
      { reasoningEffort: "medium", description: "Balanced reasoning" },
    ],
    hidden: false,
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    ...overrides,
  };
}

test("fetchCodexModels initializes the app server and returns one page of visible models", async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  let closed = 0;

  const models = await fetchCodexModels({
    clientFactory: async (): Promise<CodexAppServerClient> => ({
      async request(method: string, params: Record<string, unknown> = {}) {
        calls.push({ method, params });

        if (method === "initialize") {
          return { userAgent: "codex/test" };
        }

        if (method === "model/list") {
          return {
            data: [
              buildRawModel({ isDefault: true }),
              buildRawModel({
                id: "hidden-model",
                model: "hidden-model",
                displayName: "hidden-model",
                hidden: true,
              }),
            ],
            nextCursor: null,
          };
        }

        throw new Error(`Unexpected method: ${method}`);
      },
      async close() {
        closed += 1;
      },
    }),
  });

  expect(calls).toEqual([
    {
      method: "initialize",
      params: {
        clientInfo: {
          name: "agents-runner",
          version: "0.1.0",
        },
      },
    },
    {
      method: "model/list",
      params: {},
    },
  ]);
  expect(closed).toBe(1);
  expect(models).toEqual([
    buildExpectedModel({ isDefault: true }),
  ]);
});

test("fetchCodexModels paginates until Codex stops returning a cursor", async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  let page = 0;

  const models = await fetchCodexModels({
    clientFactory: async (): Promise<CodexAppServerClient> => ({
      async request(method: string, params: Record<string, unknown> = {}) {
        calls.push({ method, params });

        if (method === "initialize") {
          return { userAgent: "codex/test" };
        }

        if (method !== "model/list") {
          throw new Error(`Unexpected method: ${method}`);
        }

        page += 1;
        if (page === 1) {
          return {
            data: [buildRawModel({ model: "gpt-5.3-codex", displayName: "gpt-5.3-codex", isDefault: true })],
            nextCursor: "page-2",
          };
        }

        return {
          data: [buildRawModel({ model: "gpt-5.4", displayName: "gpt-5.4" })],
          nextCursor: null,
        };
      },
      async close() {},
    }),
  });

  expect(calls).toEqual([
    {
      method: "initialize",
      params: {
        clientInfo: {
          name: "agents-runner",
          version: "0.1.0",
        },
      },
    },
    { method: "model/list", params: {} },
    { method: "model/list", params: { cursor: "page-2" } },
  ]);
  expect(models).toEqual([
    buildExpectedModel({ model: "gpt-5.3-codex", displayName: "gpt-5.3-codex", isDefault: true }),
    buildExpectedModel({ model: "gpt-5.4", displayName: "gpt-5.4" }),
  ]);
});

test("createCodexModelCatalog returns stale cached models when a refresh fails", async () => {
  let nowMs = 0;
  let fetchCount = 0;
  const catalog = createCodexModelCatalog({
    now: () => nowMs,
    fetcher: async () => {
      fetchCount += 1;
      if (fetchCount === 1) {
        return [buildExpectedModel({ isDefault: true })];
      }

      throw new Error("transport unavailable");
    },
  });

  const first = await catalog.getModels();
  nowMs = (5 * 60_000) + 1;
  const second = await catalog.getModels({ refresh: true });

  expect(first.stale).toBe(false);
  expect(first.models).toEqual([buildExpectedModel({ isDefault: true })]);
  expect(second.stale).toBe(true);
  expect(second.models).toEqual(first.models);
  expect(second.fetchedAt).toBe(first.fetchedAt);
});

test("createCodexModelCatalog surfaces a clear error on cold-start failure", async () => {
  const catalog = createCodexModelCatalog({
    fetcher: async () => {
      throw new Error("auth required");
    },
  });

  let thrown: Error | null = null;
  try {
    await catalog.getModels();
  } catch (error) {
    thrown = error as Error;
  }

  expect(thrown).toBeInstanceOf(Error);
  expect(thrown!.message).toBe("Unable to load models from Codex: auth required");
});
