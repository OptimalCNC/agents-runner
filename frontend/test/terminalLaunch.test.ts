import { expect, test } from "bun:test";

import { getRunTerminalPath, resolveTerminalLaunchState } from "../src/utils/terminalLaunch.js";
import type { AppConfig } from "../src/types.js";

const baseConfig: AppConfig = {
  homeDirectory: "/home/test",
  defaults: {
    port: 3000,
    runCount: 2,
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

test("getRunTerminalPath prefers the working directory", () => {
  expect(getRunTerminalPath({
    workingDirectory: "/repo/worktrees/run-1/project",
    worktreePath: "/repo/worktrees/run-1",
  } as never)).toBe("/repo/worktrees/run-1/project");
});

test("resolveTerminalLaunchState enables auto for Windows browsers", () => {
  expect(resolveTerminalLaunchState(baseConfig, "windows", "/repo/worktrees/run-1")).toEqual({
    canLaunch: true,
    disabledReason: "",
    effectiveLauncherLabel: "Windows Terminal",
  });
});

test("resolveTerminalLaunchState disables auto outside Windows browsers", () => {
  expect(resolveTerminalLaunchState(baseConfig, "linux", "/repo/worktrees/run-1")).toEqual({
    canLaunch: false,
    disabledReason: "Auto terminal launch is only supported from Windows browsers right now.",
    effectiveLauncherLabel: "Windows Terminal",
  });
});

test("resolveTerminalLaunchState respects explicit launcher availability", () => {
  const config: AppConfig = {
    ...baseConfig,
    terminal: {
      preference: "windows-terminal",
      launchers: [{
        id: "windows-terminal",
        label: "Windows Terminal",
        supported: false,
        unsupportedReason: "Windows Terminal is not available on this host.",
      }],
    },
  };

  expect(resolveTerminalLaunchState(config, "windows", "/repo/worktrees/run-1")).toEqual({
    canLaunch: false,
    disabledReason: "Windows Terminal is not available on this host.",
    effectiveLauncherLabel: "Windows Terminal",
  });
});

test("resolveTerminalLaunchState disables the button when no run path exists", () => {
  expect(resolveTerminalLaunchState(baseConfig, "windows", "")).toEqual({
    canLaunch: false,
    disabledReason: "Run directory is not available yet.",
    effectiveLauncherLabel: "Terminal",
  });
});
