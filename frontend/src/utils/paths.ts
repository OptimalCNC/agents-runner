import type { BatchSummary } from "../types.js";

export function deriveParentPath(targetPath: string | null | undefined): string {
  const source = String(targetPath ?? "").trim();
  if (!source) return "";
  const normalized = source.replace(/[\\/]+$/, "");
  if (!normalized) return source;
  const slashIndex = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  if (slashIndex < 0) return "";
  if (slashIndex === 0) return normalized.slice(0, 1);
  if (/^[A-Za-z]:$/.test(normalized.slice(0, slashIndex))) return normalized.slice(0, slashIndex + 1);
  return normalized.slice(0, slashIndex);
}

export function getPathLeaf(targetPath: string | null | undefined): string {
  const source = String(targetPath ?? "").trim().replace(/[\\/]+$/, "");
  if (!source) return "";
  const segments = source.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] || source;
}

export function getProjectPath(batch: BatchSummary): string {
  return batch?.config?.projectPath || "";
}
