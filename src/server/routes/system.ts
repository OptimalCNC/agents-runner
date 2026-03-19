import { readBody, sendJson, type ApiRouteHandler } from "../http";
import { normalizeString } from "../payloads";
import { buildAppConfig } from "../appConfig";
import { normalizeTerminalPreference } from "../../lib/terminal";

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
      worktreeRoot: Object.hasOwn(body, "worktreeRoot")
        ? normalizeString(body.worktreeRoot)
        : context.settings.get().worktreeRoot,
      terminal: Object.hasOwn(body, "terminalPreference")
        ? { preference: normalizeTerminalPreference(body.terminalPreference) }
        : context.settings.get().terminal,
    });
    sendJson(response, 200, await buildAppConfig(context));
    return true;
  }

  return false;
};
