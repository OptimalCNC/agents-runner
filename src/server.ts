import http from "node:http";

import { handleApiRequest, isApiRequestPath } from "./server/api";
import { createServerContext } from "./server/context";
import { sendError, serveStaticFile } from "./server/http";
import { handleMcpRequest } from "./server/mcp";

const context = createServerContext();

async function main(): Promise<void> {
  await context.store.load();

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);

    try {
      if (isApiRequestPath(url.pathname)) {
        await handleApiRequest(context, request, response, url);
        return;
      }

      if (await handleMcpRequest(context, request, response, url)) {
        return;
      }

      await serveStaticFile(response, context.publicDirectory, url.pathname);
    } catch (error) {
      console.error("Request failed", error);
      if (!response.headersSent) {
        sendError(response, 500, (error as Error).message || "Internal server error.");
      } else {
        response.end();
      }
    }
  });

  server.listen(context.port, () => {
    console.log(`Agents Runner listening on http://localhost:${context.port}`);
  });
}

main().catch((error: unknown) => {
  console.error("Server failed to start", error);
  process.exitCode = 1;
});
