import path from "node:path";

import { collectWorktreeReview, inspectProject, listDirectories } from "../../lib/git";
import { createRunBranch } from "../../lib/runner";
import { readBody, sendError, sendJson, type ApiRouteHandler } from "../http";
import { normalizeCreateBranchPayload, normalizeString } from "../payloads";

export const handleProjectWorktreeRoutes: ApiRouteHandler = async (context, request, response, url) => {
  if (request.method === "POST" && url.pathname === "/api/project/inspect") {
    const body = await readBody(request);
    const targetPath = normalizeString(body.path);

    if (!targetPath) {
      throw new Error("Path is required.");
    }

    const projectContext = await inspectProject(path.resolve(targetPath));
    sendJson(response, 200, { projectContext });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/fs") {
    const listing = await listDirectories(url.searchParams.get("path") || undefined);
    sendJson(response, 200, listing);
    return true;
  }

  const branchMatch = url.pathname.match(/^\/api\/batches\/([^/]+)\/runs\/([^/]+)\/branch$/);
  if (request.method === "POST" && branchMatch) {
    const body = await readBody(request);
    const payload = normalizeCreateBranchPayload(body);

    try {
      const batch = await createRunBranch(
        context.store,
        decodeURIComponent(branchMatch[1]),
        decodeURIComponent(branchMatch[2]),
        payload.branchName,
      );

      if (!batch) {
        sendError(response, 404, "Batch not found.");
        return true;
      }

      sendJson(response, 200, { batch });
    } catch (error) {
      sendError(response, 409, (error as Error).message || "Failed to create branch.");
    }
    return true;
  }

  const reviewMatch = url.pathname.match(/^\/api\/batches\/([^/]+)\/runs\/([^/]+)\/review$/);
  if (request.method === "GET" && reviewMatch) {
    const batchId = decodeURIComponent(reviewMatch[1]);
    const runId = decodeURIComponent(reviewMatch[2]);
    const batch = context.store.getBatch(batchId);

    if (!batch) {
      sendError(response, 404, "Batch not found.");
      return true;
    }

    const run = batch.runs.find((entry) => entry.id === runId);
    if (!run) {
      sendError(response, 404, "Run not found.");
      return true;
    }

    if (!run.worktreePath) {
      sendJson(response, 200, { review: run.review });
      return true;
    }

    const review = await collectWorktreeReview(run.worktreePath);
    context.store.updateRun(batchId, runId, (mutableRun) => {
      mutableRun.review = review;
    });
    sendJson(response, 200, { review });
    return true;
  }

  return false;
};
