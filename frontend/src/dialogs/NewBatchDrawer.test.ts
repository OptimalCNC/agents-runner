import { expect, test } from "bun:test";

import {
  buildInitialDrawerState,
  DEFAULT_RANKED_REVIEW_PROMPT,
  getDefaultReviewPrompt,
  resolveReviewPromptForModeChange,
} from "./NewBatchDrawer.js";
import type { AppConfig, NewBatchDraft } from "../types.js";

const appConfig: AppConfig = {
  homeDirectory: "/home/test",
  defaults: {
    port: 3000,
    runCount: 10,
    sandboxMode: "workspace-write",
    worktreeRoot: "/worktrees",
  },
  terminal: {
    preference: "auto",
    launchers: [{
      id: "windows-terminal",
      label: "Windows Terminal",
      supported: true,
      unsupportedReason: null,
    }],
  },
  codexEnvironment: {
    hasOpenAIApiKey: false,
    hasCodexProfile: true,
  },
};

function buildDraft(mode: NewBatchDraft["mode"], reviewPrompt = ""): NewBatchDraft {
  return {
    mode,
    config: {
      runCount: 2,
      concurrency: 2,
      reviewCount: 3,
      projectPath: "/repo/project",
      worktreeRoot: "/repo",
      prompt: "Do work.",
      taskPrompt: "",
      reviewPrompt,
      baseRef: "main",
      model: "",
      sandboxMode: "workspace-write",
      networkAccessEnabled: false,
      webSearchMode: "disabled",
      reasoningEffort: "",
    },
  };
}

test("buildInitialDrawerState keeps validated checker prompt blank by default", () => {
  const state = buildInitialDrawerState(appConfig, buildDraft("validated", ""));
  expect(state.reviewPrompt).toBe("");
});

test("buildInitialDrawerState keeps ranked review prompt default", () => {
  const state = buildInitialDrawerState(appConfig, buildDraft("ranked", ""));
  expect(state.reviewPrompt).toBe(DEFAULT_RANKED_REVIEW_PROMPT);
});

test("buildInitialDrawerState uses a blank review prompt for a fresh repeated batch", () => {
  const state = buildInitialDrawerState(appConfig, null);
  expect(state.mode).toBe("repeated");
  expect(state.reviewPrompt).toBe("");
});

test("resolveReviewPromptForModeChange clears the ranked default when switching to validated", () => {
  expect(resolveReviewPromptForModeChange("ranked", "validated", DEFAULT_RANKED_REVIEW_PROMPT)).toBe("");
});

test("resolveReviewPromptForModeChange restores the ranked default when switching from blank to ranked", () => {
  expect(resolveReviewPromptForModeChange("validated", "ranked", "")).toBe(DEFAULT_RANKED_REVIEW_PROMPT);
});

test("resolveReviewPromptForModeChange preserves custom prompts across mode changes", () => {
  expect(resolveReviewPromptForModeChange("ranked", "validated", "Inspect every worker carefully.")).toBe(
    "Inspect every worker carefully.",
  );
});

test("getDefaultReviewPrompt only returns a default for ranked mode", () => {
  expect(getDefaultReviewPrompt("ranked")).toBe(DEFAULT_RANKED_REVIEW_PROMPT);
  expect(getDefaultReviewPrompt("validated")).toBe("");
});
