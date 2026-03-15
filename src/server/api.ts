import type { IncomingMessage, ServerResponse } from "node:http";

import { sendError, type ApiRouteHandler } from "./http";
import { handleAuthModelRoutes } from "./routes/authModels";
import { handleBatchRoutes } from "./routes/batches";
import { handleEventTransportRequest } from "./routes/events";
import { handleMcpRoutes } from "./routes/mcp";
import { handleProjectWorktreeRoutes } from "./routes/projects";
import { handleSystemRoutes } from "./routes/system";

import type { ServerContext } from "./context";

const apiRouteHandlers: ApiRouteHandler[] = [
  handleSystemRoutes,
  handleAuthModelRoutes,
  handleMcpRoutes,
  handleBatchRoutes,
  handleProjectWorktreeRoutes,
  handleEventTransportRequest,
];

export function isApiRequestPath(pathname: string): boolean {
  return pathname.startsWith("/api/") || pathname === "/events";
}

export async function handleApiRequest(
  context: ServerContext,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<void> {
  for (const handler of apiRouteHandlers) {
    if (await handler(context, request, response, url)) {
      return;
    }
  }

  sendError(response, 404, "Not found.");
}
