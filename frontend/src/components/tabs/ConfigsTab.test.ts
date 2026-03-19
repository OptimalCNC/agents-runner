import { expect, test } from "bun:test";

import { buildSessionDetails } from "./ConfigsTab.js";
import type { CodexTurnConfig } from "../../types.js";

test("buildSessionDetails includes additional directories when present", () => {
  const config: CodexTurnConfig = {
    launchMode: "start",
    developerPrompt: null,
    clientConfig: {},
    sessionConfig: {
      model: "gpt-5-codex",
      sandboxMode: "read-only",
      approvalPolicy: "never",
      workingDirectory: "/repo/project",
      additionalDirectories: ["/repo/worktrees/run-1", "/repo/worktrees/run-2"],
      networkAccessEnabled: false,
      webSearchEnabled: false,
      webSearchMode: "disabled",
      modelReasoningEffort: null,
    },
    resumeThreadId: null,
  };

  const details = buildSessionDetails(config);
  expect(details.find((item) => item.label === "Additional Directories")).toEqual({
    label: "Additional Directories",
    value: "/repo/worktrees/run-1\n/repo/worktrees/run-2",
    mono: true,
    multiline: true,
  });
});
