import os from "node:os";

import { hasCodexProfile } from "./codexCredentials";
import { DEFAULT_RUN_COUNT, DEFAULT_SANDBOX_MODE } from "./constants";
import { detectTerminalHostInfo, getTerminalLaunchers, type TerminalHostInfo } from "../lib/terminal";

import type { ServerContext } from "./context";

interface BuildAppConfigDependencies {
  hasCodexProfileFn?: () => Promise<boolean>;
  hostInfo?: TerminalHostInfo;
}

export async function buildAppConfig(
  context: ServerContext,
  {
    hasCodexProfileFn = hasCodexProfile,
    hostInfo = detectTerminalHostInfo(),
  }: BuildAppConfigDependencies = {},
) {
  return {
    cwd: context.projectRoot,
    homeDirectory: os.homedir(),
    defaults: {
      port: context.port,
      runCount: DEFAULT_RUN_COUNT,
      sandboxMode: DEFAULT_SANDBOX_MODE,
      worktreeRoot: context.settings.get().worktreeRoot,
    },
    terminal: {
      preference: context.settings.get().terminal.preference,
      launchers: getTerminalLaunchers(hostInfo),
    },
    codexEnvironment: {
      hasOpenAIApiKey: Boolean(process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY),
      hasCodexProfile: await hasCodexProfileFn(),
    },
  };
}
