import fs from "node:fs/promises";

import { launchTerminal } from "../../lib/terminal";
import { readBody, sendError, sendJson, type ApiRouteHandler } from "../http";
import { normalizeLaunchTerminalPayload } from "../payloads";

import type { ClientPlatform, TerminalPreference } from "../../types";

interface TerminalRouteDependencies {
  launch?: (options: { path: string; preference: TerminalPreference; clientPlatform: ClientPlatform }) => Promise<{ launcherId: string; launcherLabel: string }>;
}

export function createTerminalRouteHandler({ launch = launchTerminal }: TerminalRouteDependencies = {}): ApiRouteHandler {
  return async (context, request, response, url) => {
    if (request.method !== "POST" || url.pathname !== "/api/terminal/launch") {
      return false;
    }

    const body = await readBody(request);
    const payload = normalizeLaunchTerminalPayload(body);

    if (!payload.path) {
      sendError(response, 400, "Path is required.");
      return true;
    }

    if (!(payload.path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(payload.path) || /^\\\\/.test(payload.path))) {
      sendError(response, 400, "Path must be absolute.");
      return true;
    }

    let stats;
    try {
      stats = await fs.stat(payload.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        sendError(response, 404, "Directory not found.");
        return true;
      }

      throw error;
    }

    if (!stats.isDirectory()) {
      sendError(response, 409, "Path is not a directory.");
      return true;
    }

    try {
      const resolved = await launch({
        path: payload.path,
        preference: context.settings.get().terminal.preference,
        clientPlatform: payload.clientPlatform,
      });
      sendJson(response, 202, {
        launched: true,
        launcherId: resolved.launcherId,
        launcherLabel: resolved.launcherLabel,
      });
    } catch (error) {
      sendError(response, 409, (error as Error).message || "Failed to launch terminal.");
    }

    return true;
  };
}

export const handleTerminalRoutes = createTerminalRouteHandler();
