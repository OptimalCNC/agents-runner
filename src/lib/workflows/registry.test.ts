import { expect, test } from "bun:test";

import type { BatchMode } from "../../types";
import { getWorkflow } from "./registry";

const ALL_MODES: BatchMode[] = ["repeated", "generated", "ranked", "validated"];
const REQUIRED_METHODS = [
  "validatePayload",
  "getMaxConcurrency",
  "buildInitialBatchState",
  "getTitleSourcePrompt",
  "createTasks",
  "executeBatchRuns",
  "onScoreSubmitted",
  "onBatchSettled",
] as const;

test("registry has a workflow for every BatchMode value", () => {
  for (const mode of ALL_MODES) {
    expect(() => getWorkflow(mode)).not.toThrow();
    expect(getWorkflow(mode).mode).toBe(mode);
  }
});

test("getWorkflow throws for unknown mode", () => {
  expect(() => getWorkflow("nonexistent" as BatchMode)).toThrow();
});

test("each workflow implements all required WorkflowDefinition methods", () => {
  for (const mode of ALL_MODES) {
    const workflow = getWorkflow(mode);
    for (const method of REQUIRED_METHODS) {
      expect(typeof (workflow as unknown as Record<string, unknown>)[method]).toBe("function");
    }
  }
});

test("each workflow has a non-empty label", () => {
  for (const mode of ALL_MODES) {
    expect(getWorkflow(mode).label.length).toBeGreaterThan(0);
  }
});

test("ranked and validated workflows have preCreateCheck", () => {
  expect(getWorkflow("repeated").preCreateCheck).toBeUndefined();
  expect(getWorkflow("generated").preCreateCheck).toBeUndefined();
  expect(typeof getWorkflow("ranked").preCreateCheck).toBe("function");
  expect(typeof getWorkflow("validated").preCreateCheck).toBe("function");
});

test("workflow mode property matches registry key", () => {
  for (const mode of ALL_MODES) {
    expect(getWorkflow(mode).mode).toBe(mode);
  }
});
