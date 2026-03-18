import os from "node:os";

import { hasCodexProfile } from "../codexCredentials";
import { DEFAULT_RUN_COUNT, DEFAULT_SANDBOX_MODE } from "../constants";
import { readBody, sendJson, type ApiRouteHandler } from "../http";
import { normalizeString } from "../payloads";

async function buildAppConfig(context: Parameters<ApiRouteHandler>[0]) {
  return {
    cwd: context.projectRoot,
    homeDirectory: os.homedir(),
    defaults: {
      port: context.port,
      runCount: DEFAULT_RUN_COUNT,
      sandboxMode: DEFAULT_SANDBOX_MODE,
      worktreeRoot: context.settings.get().worktreeRoot,
    },
    codexEnvironment: {
      hasOpenAIApiKey: Boolean(process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY),
      hasCodexProfile: await hasCodexProfile(),
    },
  };
}

export const handleSystemRoutes: ApiRouteHandler = async (context, request, response, url) => {
  if (url.pathname !== "/api/config") {
    return false;
  }

  if (request.method === "GET") {
    sendJson(response, 200, await buildAppConfig(context));
    return true;
  }

  if (request.method === "PUT") {
    const body = await readBody(request);
    await context.settings.update({
      worktreeRoot: normalizeString(body.worktreeRoot),
    });
    sendJson(response, 200, await buildAppConfig(context));
    return true;
  }

  return false;
};
