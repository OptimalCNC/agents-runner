import { expect, test } from "bun:test";

import { buildMockBatch } from "./test-helpers";
import { buildTaskGenerationPrompt, buildTaskSchema } from "./generated";
import { getWorkflow } from "./registry";

const wf = getWorkflow("generated");

test("generated workflow validates that taskPrompt is required", () => {
  expect(() => wf.validatePayload({ prompt: "X", taskPrompt: "", reviewPrompt: "" })).toThrow();
  expect(() => wf.validatePayload({ prompt: "", taskPrompt: "Gen tasks", reviewPrompt: "" })).not.toThrow();
});

test("generated workflow max concurrency equals runCount", () => {
  expect(wf.getMaxConcurrency(5, 3)).toBe(5);
  expect(wf.getMaxConcurrency(10, 1)).toBe(10);
});

test("generated workflow has pending generation state", () => {
  const state = wf.buildInitialBatchState();
  expect(state.generation).not.toBeNull();
  expect(state.generation!.status).toBe("pending");
  expect(state.generation!.tasks).toEqual([]);
  expect(state.generation!.startedAt).toBeNull();
  expect(state.generation!.error).toBeNull();
});

test("generated workflow uses config.taskPrompt for title", () => {
  const batch = buildMockBatch({ mode: "generated", prompt: "Fix bugs", taskPrompt: "Gen tasks" });
  expect(wf.getTitleSourcePrompt(batch)).toBe("Gen tasks");
});

test("buildTaskGenerationPrompt includes task count and user prompt", () => {
  const result = buildTaskGenerationPrompt("Make features", 5);
  expect(result).toContain("5");
  expect(result).toContain("Make features");
  expect(result).toContain("Generate exactly 5 coding tasks");
});

test("buildTaskSchema sets minItems and maxItems to the given count", () => {
  const schema = buildTaskSchema(3) as { properties: { tasks: { minItems: number; maxItems: number } } };
  expect(schema.properties.tasks.minItems).toBe(3);
  expect(schema.properties.tasks.maxItems).toBe(3);
});

test("buildTaskSchema enforces required fields on task items", () => {
  const schema = buildTaskSchema(2) as {
    properties: {
      tasks: {
        items: { required: string[]; properties: Record<string, unknown> };
      };
    };
  };
  expect(schema.properties.tasks.items.required).toContain("title");
  expect(schema.properties.tasks.items.required).toContain("prompt");
});

test("generated workflow has no preCreateCheck", () => {
  expect(wf.preCreateCheck).toBeUndefined();
});
