import fs from "node:fs";
import fsp from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

import type { ServerContext } from "./context";

const mimeTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

export type ApiRouteHandler = (
  context: ServerContext,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
) => Promise<boolean>;

export function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(`${JSON.stringify(payload)}\n`);
}

export function sendError(response: ServerResponse, statusCode: number, message: string): void {
  sendJson(response, statusCode, { error: message });
}

export function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = "";

    request.on("data", (chunk: Buffer) => {
      body += chunk.toString();
      if (body.length > 1_000_000) {
        reject(new Error("Request body too large."));
        request.destroy();
      }
    });

    request.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON payload."));
      }
    });

    request.on("error", reject);
  });
}

export async function serveStaticFile(
  response: ServerResponse,
  publicDirectory: string,
  pathname: string,
): Promise<void> {
  const relativePath = pathname === "/" ? "/index.html" : pathname;
  const targetPath = path.normalize(path.join(publicDirectory, relativePath));

  if (!targetPath.startsWith(publicDirectory)) {
    sendError(response, 403, "Forbidden.");
    return;
  }

  try {
    const stats = await fsp.stat(targetPath);
    if (!stats.isFile()) {
      sendError(response, 404, "Not found.");
      return;
    }

    response.writeHead(200, {
      "Content-Type": mimeTypes[path.extname(targetPath)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    fs.createReadStream(targetPath).pipe(response);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      sendError(response, 404, "Not found.");
      return;
    }

    throw error;
  }
}

