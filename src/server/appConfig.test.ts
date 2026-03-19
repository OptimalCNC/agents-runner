import { expect, test } from "bun:test";

import { buildAppConfig } from "./appConfig";

test("buildAppConfig includes terminal settings and launcher metadata", async () => {
  const config = await buildAppConfig({
    projectRoot: "/repo",
    publicDirectory: "/repo/public",
    port: 3000,
    store: {} as never,
    settings: {
      load: async () => {},
      get: () => ({
        worktreeRoot: "/worktrees",
        terminal: {
          preference: "windows-terminal",
        },
      }),
      update: async () => ({
        worktreeRoot: "/worktrees",
        terminal: {
          preference: "windows-terminal",
        },
      }),
    },
    modelCatalog: {} as never,
  }, {
    hasCodexProfileFn: async () => true,
    hostInfo: {
      platform: "linux",
      isWsl: true,
      wslDistroName: "Ubuntu-24.04",
      wtCommand: "wt.exe",
    },
  });

  expect(config.defaults.worktreeRoot).toBe("/worktrees");
  expect(config.terminal).toEqual({
    preference: "windows-terminal",
    launchers: [{
      id: "windows-terminal",
      label: "Windows Terminal",
      supported: true,
      unsupportedReason: null,
    }],
  });
  expect(config.codexEnvironment.hasCodexProfile).toBe(true);
});
