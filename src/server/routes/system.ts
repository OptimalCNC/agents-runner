import os from "node:os";

import { hasCodexProfile } from "../codexCredentials";
import { DEFAULT_RUN_COUNT, DEFAULT_SANDBOX_MODE } from "../constants";
import { sendJson, type ApiRouteHandler } from "../http";

export const handleSystemRoutes: ApiRouteHandler = async (context, request, response, url) => {
  if (request.method !== "GET" || url.pathname !== "/api/config") {
    return false;
  }

  sendJson(response, 200, {
    cwd: context.projectRoot,
    homeDirectory: os.homedir(),
    defaults: {
      port: context.port,
      runCount: DEFAULT_RUN_COUNT,
      sandboxMode: DEFAULT_SANDBOX_MODE,
    },
    codexEnvironment: {
      hasOpenAIApiKey: Boolean(process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY),
      hasCodexProfile: await hasCodexProfile(),
    },
  });
  return true;
};

