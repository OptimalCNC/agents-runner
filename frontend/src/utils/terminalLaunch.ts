import type { AppConfig, ClientPlatform, Run, TerminalLauncherInfo, TerminalPreference } from "../types.js";

export interface TerminalLaunchState {
  canLaunch: boolean;
  disabledReason: string;
  effectiveLauncherLabel: string;
}

function getLauncherInfo(
  launchers: readonly TerminalLauncherInfo[],
  preference: Exclude<TerminalPreference, "auto">,
): TerminalLauncherInfo | undefined {
  return launchers.find((launcher) => launcher.id === preference);
}

export function getRunTerminalPath(run: Pick<Run, "workingDirectory" | "worktreePath"> | null | undefined): string {
  return String(run?.workingDirectory || run?.worktreePath || "").trim();
}

export function resolveTerminalLaunchState(
  config: AppConfig | null,
  clientPlatform: ClientPlatform,
  targetPath: string,
): TerminalLaunchState {
  if (!targetPath.trim()) {
    return {
      canLaunch: false,
      disabledReason: "Run directory is not available yet.",
      effectiveLauncherLabel: "Terminal",
    };
  }

  if (!config) {
    return {
      canLaunch: false,
      disabledReason: "App settings are still loading.",
      effectiveLauncherLabel: "Terminal",
    };
  }

  const { preference, launchers } = config.terminal;

  if (preference === "auto") {
    const windowsTerminal = getLauncherInfo(launchers, "windows-terminal");
    if (clientPlatform !== "windows") {
      return {
        canLaunch: false,
        disabledReason: "Auto terminal launch is only supported from Windows browsers right now.",
        effectiveLauncherLabel: windowsTerminal?.label || "Windows Terminal",
      };
    }

    if (!windowsTerminal?.supported) {
      return {
        canLaunch: false,
        disabledReason: windowsTerminal?.unsupportedReason || "Windows Terminal is not available on this host.",
        effectiveLauncherLabel: windowsTerminal?.label || "Windows Terminal",
      };
    }

    return {
      canLaunch: true,
      disabledReason: "",
      effectiveLauncherLabel: windowsTerminal.label,
    };
  }

  const launcher = getLauncherInfo(launchers, preference);
  if (!launcher?.supported) {
    return {
      canLaunch: false,
      disabledReason: launcher?.unsupportedReason || "The selected terminal launcher is not available on this host.",
      effectiveLauncherLabel: launcher?.label || "Terminal",
    };
  }

  return {
    canLaunch: true,
    disabledReason: "",
    effectiveLauncherLabel: launcher.label,
  };
}
