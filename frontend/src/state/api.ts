import type {
  AppConfig,
  Batch,
  BatchSummary,
  CodexAuthValidationResponse,
  DirectoryListing,
  ModelCatalogResponse,
  ProjectContext,
  RunReview,
} from "../types.js";

export class ApiError extends Error {
  status: number;
  details?: unknown;
  constructor(message: string, status: number, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export async function fetchJson<T = unknown>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(options.headers as Record<string, string> || {}) },
    ...options,
  });
  const payload = await response.json().catch(() => ({})) as { error?: string; details?: unknown } & T;
  if (!response.ok) {
    throw new ApiError(
      (payload as { error?: string }).error || `Request failed with ${response.status}`,
      response.status,
      (payload as { details?: unknown }).details,
    );
  }
  return payload;
}

export async function apiLoadConfig(): Promise<AppConfig> {
  return fetchJson<AppConfig>("/api/config");
}

export async function apiLoadBatches(): Promise<{ batches: BatchSummary[] }> {
  return fetchJson<{ batches: BatchSummary[] }>("/api/batches");
}

export async function apiLoadBatch(batchId: string): Promise<{ batch: Batch }> {
  return fetchJson<{ batch: Batch }>(`/api/batches/${encodeURIComponent(batchId)}`);
}

export async function apiInspectProject(path: string): Promise<{ projectContext: ProjectContext }> {
  return fetchJson<{ projectContext: ProjectContext }>("/api/project/inspect", {
    method: "POST",
    body: JSON.stringify({ path }),
  });
}

export async function apiSubmitBatch(payload: Record<string, unknown>): Promise<{ batch: Batch }> {
  return fetchJson<{ batch: Batch }>("/api/batches", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function apiBrowseFs(path: string): Promise<DirectoryListing> {
  return fetchJson<DirectoryListing>(`/api/fs?path=${encodeURIComponent(path)}`);
}

export async function apiLoadModels(refresh = false): Promise<ModelCatalogResponse> {
  return fetchJson<ModelCatalogResponse>(refresh ? "/api/models?refresh=1" : "/api/models");
}

export async function apiLoadCodexAuthStatus(): Promise<CodexAuthValidationResponse> {
  return fetchJson<CodexAuthValidationResponse>("/api/auth/status");
}

export async function apiCancelBatch(batchId: string): Promise<void> {
  await fetchJson(`/api/batches/${encodeURIComponent(batchId)}/cancel`, { method: "POST" });
}

export async function apiDeleteBatch(batchId: string, removeWorktrees: boolean): Promise<{ cleanup?: { removedCount: number } }> {
  return fetchJson(`/api/batches/${encodeURIComponent(batchId)}`, {
    method: "DELETE",
    body: JSON.stringify({ removeWorktrees }),
  });
}

export async function apiGetDeletePreview(batchId: string): Promise<{ preview: { worktreeCount: number; worktrees: import("../types.js").WorktreeInspection[] } }> {
  return fetchJson(`/api/batches/${encodeURIComponent(batchId)}/delete-preview`);
}

export async function apiGetRunReview(batchId: string, runId: string): Promise<{ review: RunReview }> {
  return fetchJson<{ review: RunReview }>(
    `/api/batches/${encodeURIComponent(batchId)}/runs/${encodeURIComponent(runId)}/review`,
  );
}

export async function apiContinueRun(batchId: string, runId: string, prompt: string): Promise<{ batch: Batch }> {
  return fetchJson<{ batch: Batch }>(
    `/api/batches/${encodeURIComponent(batchId)}/runs/${encodeURIComponent(runId)}/continue`,
    {
      method: "POST",
      body: JSON.stringify({ prompt }),
    },
  );
}
