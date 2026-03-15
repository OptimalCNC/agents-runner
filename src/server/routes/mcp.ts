import { getBundledMcpStatus, installBundledMcpServer } from "../../lib/codexMcp";
import { sendError, sendJson, type ApiRouteHandler } from "../http";

export const handleMcpRoutes: ApiRouteHandler = async (context, request, response, url) => {
  if (request.method === "GET" && url.pathname === "/api/mcp/status") {
    try {
      const status = await getBundledMcpStatus(context.port);
      sendJson(response, 200, { status });
    } catch (error) {
      sendError(response, 500, (error as Error).message || "Failed to load MCP status.");
    }
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/mcp/install") {
    try {
      const status = await installBundledMcpServer(context.port);
      sendJson(response, 200, { status });
    } catch (error) {
      sendError(response, 500, (error as Error).message || "Failed to install MCP server.");
    }
    return true;
  }

  return false;
};
