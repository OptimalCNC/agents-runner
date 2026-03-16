import {
  cancelBatch,
  continueRun,
  deleteBatch,
  executeBatch,
  generateBatchTitle,
  previewBatchDelete,
} from "../../lib/runner";
import { readBody, sendError, sendJson, type ApiRouteHandler } from "../http";
import {
  normalizeContinueRunPayload,
  normalizeCreateBatchPayload,
  normalizeDeleteBatchPayload,
} from "../payloads";
import { getBundledMcpStatus } from "../../lib/codexMcp";

export const handleBatchRoutes: ApiRouteHandler = async (context, request, response, url) => {
  if (request.method === "GET" && url.pathname === "/api/batches") {
    sendJson(response, 200, { batches: context.store.listSummaries() });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/batches") {
    const body = await readBody(request);
    const payload = normalizeCreateBatchPayload(body);

    if (payload.mode === "ranked") {
      const mcpStatus = await getBundledMcpStatus(context.port);
      if (!mcpStatus.healthy) {
        sendError(
          response,
          409,
          "Ranked workflow requires bundled MCP tools. Open Settings and install/repair the Agents Runner MCP server first.",
        );
        return true;
      }
    }

    const batch = context.store.createBatch(payload);

    if (payload.autoGenerateTitle) {
      void generateBatchTitle(context.store, batch.id).catch((error: unknown) => {
        console.error(`Batch ${batch.id} title generation failed`, error);
      });
    }

    void executeBatch(context.store, batch.id).catch((error: unknown) => {
      console.error(`Batch ${batch.id} failed`, error);
    });

    sendJson(response, 202, { batch: context.store.getBatch(batch.id) });
    return true;
  }

  const deletePreviewMatch = url.pathname.match(/^\/api\/batches\/([^/]+)\/delete-preview$/);
  if (request.method === "GET" && deletePreviewMatch) {
    const preview = await previewBatchDelete(context.store, decodeURIComponent(deletePreviewMatch[1]));
    if (!preview) {
      sendError(response, 404, "Batch not found.");
      return true;
    }

    sendJson(response, 200, { preview });
    return true;
  }

  const batchIdMatch = url.pathname.match(/^\/api\/batches\/([^/]+)$/);
  if (request.method === "GET" && batchIdMatch) {
    const batch = context.store.getBatch(decodeURIComponent(batchIdMatch[1]));
    if (!batch) {
      sendError(response, 404, "Batch not found.");
      return true;
    }

    sendJson(response, 200, { batch });
    return true;
  }

  if (request.method === "DELETE" && batchIdMatch) {
    const body = await readBody(request);
    const payload = normalizeDeleteBatchPayload(body);

    try {
      const result = await deleteBatch(context.store, decodeURIComponent(batchIdMatch[1]), payload);
      if (!result) {
        sendError(response, 404, "Batch not found.");
        return true;
      }

      sendJson(response, 200, result);
    } catch (error) {
      if ((error as { statusCode?: number })?.statusCode === 409) {
        sendJson(response, 409, {
          error: (error as Error).message || "Failed to remove worktrees.",
          details: (error as { details?: unknown }).details || null,
        });
        return true;
      }

      throw error;
    }
    return true;
  }

  const cancelMatch = url.pathname.match(/^\/api\/batches\/([^/]+)\/cancel$/);
  if (request.method === "POST" && cancelMatch) {
    const batch = cancelBatch(context.store, decodeURIComponent(cancelMatch[1]));
    if (!batch) {
      sendError(response, 404, "Batch not found.");
      return true;
    }

    sendJson(response, 202, { batch });
    return true;
  }

  const continueRunMatch = url.pathname.match(/^\/api\/batches\/([^/]+)\/runs\/([^/]+)\/continue$/);
  if (request.method === "POST" && continueRunMatch) {
    const body = await readBody(request);
    const payload = normalizeContinueRunPayload(body);

    try {
      const batch = await continueRun(
        context.store,
        decodeURIComponent(continueRunMatch[1]),
        decodeURIComponent(continueRunMatch[2]),
        payload.prompt,
      );

      if (!batch) {
        sendError(response, 404, "Batch not found.");
        return true;
      }

      sendJson(response, 202, { batch });
    } catch (error) {
      sendError(response, 409, (error as Error).message || "Failed to continue run.");
    }
    return true;
  }

  return false;
};
