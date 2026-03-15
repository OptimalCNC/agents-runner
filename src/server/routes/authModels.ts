import { detectCodexAuthStatus } from "../../lib/codexAuth";
import { hasCodexCredentials } from "../codexCredentials";
import { sendError, sendJson, type ApiRouteHandler } from "../http";

import type { CodexAuthValidationResponse } from "../../types";

export const handleAuthModelRoutes: ApiRouteHandler = async (context, request, response, url) => {
  if (
    request.method === "GET"
    && (url.pathname === "/api/auth/status" || url.pathname === "/api/auth/validate")
  ) {
    const checkedAt = new Date().toISOString();
    const status = await detectCodexAuthStatus();
    const payload: CodexAuthValidationResponse = {
      checkedAt,
      ...status,
    };
    sendJson(response, 200, payload);
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/models") {
    if (!await hasCodexCredentials()) {
      sendError(
        response,
        503,
        "No Codex credentials detected. Sign in with Codex or set OPENAI_API_KEY/CODEX_API_KEY.",
      );
      return true;
    }

    const refresh = url.searchParams.get("refresh") === "1";
    const payload = await context.modelCatalog.getModels({ refresh });
    sendJson(response, 200, payload);
    return true;
  }

  return false;
};

