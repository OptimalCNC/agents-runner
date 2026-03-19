import { EventEmitter } from "node:events";

import { describe, expect, test } from "bun:test";

import {
  buildWindowsTerminalLaunchCommand,
  detectTerminalHostInfo,
  getTerminalLaunchers,
  resolveTerminalLauncher,
  spawnDetachedProcess,
} from "./terminal";

describe("terminal launcher", () => {
  test("detectTerminalHostInfo recognizes a supported WSL host", () => {
    const hostInfo = detectTerminalHostInfo({
      platform: "linux",
      release: "6.6.0-microsoft-standard-WSL2",
      env: {
        PATH: "/usr/bin:/mnt/c/Users/test/AppData/Local/Microsoft/WindowsApps",
        WSL_DISTRO_NAME: "Ubuntu-24.04",
        WSL_INTEROP: "/run/WSL/1_interop",
      },
      executableExists: () => true,
    });

    expect(hostInfo).toEqual({
      platform: "linux",
      isWsl: true,
      wslDistroName: "Ubuntu-24.04",
      wtCommand: "wt.exe",
    });
  });

  test("resolveTerminalLauncher maps auto to Windows Terminal for Windows browsers", () => {
    const resolved = resolveTerminalLauncher(
      "auto",
      "windows",
      getTerminalLaunchers({
        platform: "linux",
        isWsl: true,
        wslDistroName: "Ubuntu-24.04",
        wtCommand: "wt.exe",
      }),
    );

    expect(resolved).toEqual({
      launcherId: "windows-terminal",
      launcherLabel: "Windows Terminal",
    });
  });

  test("resolveTerminalLauncher rejects auto outside Windows browsers", () => {
    expect(() =>
      resolveTerminalLauncher(
        "auto",
        "linux",
        getTerminalLaunchers({
          platform: "linux",
          isWsl: true,
          wslDistroName: "Ubuntu-24.04",
          wtCommand: "wt.exe",
        }),
      )).toThrow("Auto terminal launch is only supported from Windows browsers right now.");
  });

  test("buildWindowsTerminalLaunchCommand uses the current WSL distro for POSIX paths", () => {
    const command = buildWindowsTerminalLaunchCommand("/mnt/d/worktrees/run-1", {
      platform: "linux",
      isWsl: true,
      wslDistroName: "Ubuntu-24.04",
      wtCommand: "wt.exe",
    });

    expect(command).toEqual({
      command: "wt.exe",
      args: ["new-tab", "wsl.exe", "-d", "Ubuntu-24.04", "--cd", "/mnt/d/worktrees/run-1"],
    });
  });

  test("spawnDetachedProcess detaches the child and drops ownership", async () => {
    const calls: Array<{ command: string; args: string[]; options: { detached: boolean; stdio: "ignore" } }> = [];
    let unrefCalled = false;

    class FakeChild extends EventEmitter {
      unref() {
        unrefCalled = true;
      }
    }

    await spawnDetachedProcess(
      "wt.exe",
      ["new-tab", "-d", "D:\\worktrees\\run-1"],
      (command, args, options) => {
        calls.push({ command, args, options });
        const child = new FakeChild();
        queueMicrotask(() => child.emit("spawn"));
        return child as never;
      },
    );

    expect(calls).toEqual([{
      command: "wt.exe",
      args: ["new-tab", "-d", "D:\\worktrees\\run-1"],
      options: {
        detached: true,
        stdio: "ignore",
      },
    }]);
    expect(unrefCalled).toBe(true);
  });
});
