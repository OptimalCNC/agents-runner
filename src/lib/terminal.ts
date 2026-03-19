import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";

import type {
  ClientPlatform,
  TerminalLauncherId,
  TerminalLauncherInfo,
  TerminalPreference,
} from "../types";

export interface TerminalHostInfo {
  platform: NodeJS.Platform;
  isWsl: boolean;
  wslDistroName: string | null;
  wtCommand: string | null;
}

interface DetectTerminalHostInfoOptions {
  platform?: NodeJS.Platform;
  release?: string;
  env?: NodeJS.ProcessEnv;
  executableExists?: (command: string, options?: { envPath?: string; platform?: NodeJS.Platform }) => boolean;
}

interface ResolveExecutableOptions {
  envPath?: string;
  platform?: NodeJS.Platform;
}

export interface ResolvedTerminalLauncher {
  launcherId: TerminalLauncherId;
  launcherLabel: string;
}

export interface TerminalLaunchCommand {
  command: string;
  args: string[];
}

export interface LaunchTerminalOptions {
  path: string;
  preference: TerminalPreference;
  clientPlatform: ClientPlatform;
  hostInfo?: TerminalHostInfo;
  spawnDetached?: (command: string, args: string[]) => Promise<void>;
}

type SpawnLike = (
  command: string,
  args: string[],
  options: {
    detached: boolean;
    stdio: "ignore";
  },
) => ChildProcess;

export function normalizeTerminalPreference(value: unknown): TerminalPreference {
  return String(value ?? "").trim().toLowerCase() === "windows-terminal" ? "windows-terminal" : "auto";
}

export function normalizeClientPlatform(value: unknown): ClientPlatform {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "windows" || normalized === "macos" || normalized === "linux") {
    return normalized;
  }
  return "unknown";
}

export function isWindowsAbsolutePath(targetPath: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(targetPath) || /^\\\\/.test(targetPath);
}

export function isPosixAbsolutePath(targetPath: string): boolean {
  return targetPath.startsWith("/");
}

export function isWslEnvironment(platform = process.platform, release = os.release(), env = process.env): boolean {
  if (platform !== "linux") {
    return false;
  }

  return Boolean(env.WSL_INTEROP || env.WSL_DISTRO_NAME || release.toLowerCase().includes("microsoft"));
}

export function executableExistsOnPath(
  command: string,
  { envPath = process.env.PATH || "", platform = process.platform }: ResolveExecutableOptions = {},
): boolean {
  const entries = envPath.split(platform === "win32" ? ";" : ":").filter(Boolean);
  const pathModule = platform === "win32" ? path.win32 : path.posix;

  for (const entry of entries) {
    const normalizedEntry = entry.replace(/^"(.*)"$/, "$1");
    if (!normalizedEntry) {
      continue;
    }

    const candidate = pathModule.join(normalizedEntry, command);
    try {
      if (pathModule.isAbsolute(candidate) && fs.existsSync(candidate)) {
        return true;
      }
    } catch {
      // Fall through to the next PATH entry.
    }
  }

  return false;
}

export function detectTerminalHostInfo({
  platform = process.platform,
  release = os.release(),
  env = process.env,
  executableExists = executableExistsOnPath,
}: DetectTerminalHostInfoOptions = {}): TerminalHostInfo {
  const isWsl = isWslEnvironment(platform, release, env);
  const wslDistroName = String(env.WSL_DISTRO_NAME ?? "").trim() || null;
  const wtCommand = executableExists("wt.exe", { envPath: env.PATH || "", platform }) ? "wt.exe" : null;

  return {
    platform,
    isWsl,
    wslDistroName,
    wtCommand,
  };
}

export function getTerminalLaunchers(hostInfo = detectTerminalHostInfo()): TerminalLauncherInfo[] {
  return [getWindowsTerminalLauncherInfo(hostInfo)];
}

export function getWindowsTerminalLauncherInfo(hostInfo = detectTerminalHostInfo()): TerminalLauncherInfo {
  if (!hostInfo.wtCommand) {
    return {
      id: "windows-terminal",
      label: "Windows Terminal",
      supported: false,
      unsupportedReason: "Windows Terminal is not available on this host.",
    };
  }

  if (hostInfo.platform === "win32") {
    return {
      id: "windows-terminal",
      label: "Windows Terminal",
      supported: true,
      unsupportedReason: null,
    };
  }

  if (hostInfo.isWsl) {
    return {
      id: "windows-terminal",
      label: "Windows Terminal",
      supported: Boolean(hostInfo.wslDistroName),
      unsupportedReason: hostInfo.wslDistroName ? null : "WSL distro information is unavailable on this host.",
    };
  }

  return {
    id: "windows-terminal",
    label: "Windows Terminal",
    supported: false,
    unsupportedReason: "Windows Terminal launch is only supported on Windows or WSL hosts.",
  };
}

export function resolveTerminalLauncher(
  preference: TerminalPreference,
  clientPlatform: ClientPlatform,
  launchers: readonly TerminalLauncherInfo[],
): ResolvedTerminalLauncher {
  const windowsTerminal = launchers.find((launcher) => launcher.id === "windows-terminal");

  if (preference === "auto") {
    if (clientPlatform !== "windows") {
      throw new Error("Auto terminal launch is only supported from Windows browsers right now.");
    }

    if (!windowsTerminal?.supported) {
      throw new Error(windowsTerminal?.unsupportedReason || "Windows Terminal is not available on this host.");
    }

    return {
      launcherId: "windows-terminal",
      launcherLabel: windowsTerminal.label,
    };
  }

  if (!windowsTerminal?.supported) {
    throw new Error(windowsTerminal?.unsupportedReason || "Windows Terminal is not available on this host.");
  }

  return {
    launcherId: "windows-terminal",
    launcherLabel: windowsTerminal.label,
  };
}

export function buildWindowsTerminalLaunchCommand(
  targetPath: string,
  hostInfo = detectTerminalHostInfo(),
): TerminalLaunchCommand {
  if (!hostInfo.wtCommand) {
    throw new Error("Windows Terminal is not available on this host.");
  }

  if (isWindowsAbsolutePath(targetPath)) {
    return {
      command: hostInfo.wtCommand,
      args: ["new-tab", "-d", targetPath],
    };
  }

  if (isPosixAbsolutePath(targetPath)) {
    if (!hostInfo.isWsl) {
      throw new Error("POSIX paths can only be launched through Windows Terminal when Agents Runner is running inside WSL.");
    }

    if (!hostInfo.wslDistroName) {
      throw new Error("WSL distro information is unavailable on this host.");
    }

    return {
      command: hostInfo.wtCommand,
      args: ["new-tab", "wsl.exe", "-d", hostInfo.wslDistroName, "--cd", targetPath],
    };
  }

  throw new Error("Path must be an absolute Windows or POSIX directory.");
}

export async function spawnDetachedProcess(
  command: string,
  args: string[],
  spawnImpl: SpawnLike = spawn,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawnImpl(command, args, {
      detached: true,
      stdio: "ignore",
    });

    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

export async function launchTerminal(options: LaunchTerminalOptions): Promise<ResolvedTerminalLauncher> {
  const hostInfo = options.hostInfo ?? detectTerminalHostInfo();
  const launchers = getTerminalLaunchers(hostInfo);
  const resolved = resolveTerminalLauncher(options.preference, options.clientPlatform, launchers);
  const command = resolved.launcherId === "windows-terminal"
    ? buildWindowsTerminalLaunchCommand(options.path, hostInfo)
    : null;

  if (!command) {
    throw new Error(`Unsupported terminal launcher: ${resolved.launcherId}`);
  }

  await (options.spawnDetached ?? spawnDetachedProcess)(command.command, command.args);
  return resolved;
}
