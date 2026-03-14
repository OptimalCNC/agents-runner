import type { BatchSummary } from "../types.js";

function normalizeProjectPathValue(targetPath: string | null | undefined): string {
  return String(targetPath ?? "").trim();
}

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

export function buildProjectPathOptions(projectPaths: string[]) {
  const normalizedPaths = Array.from(
    new Set(projectPaths.map((projectPath) => normalizeProjectPathValue(projectPath)).filter(Boolean)),
  ).sort((left, right) => {
    const byLeaf = getPathLeaf(left).localeCompare(getPathLeaf(right));
    return byLeaf || left.localeCompare(right);
  });

  const leafCounts = new Map<string, number>();
  for (const projectPath of normalizedPaths) {
    const leaf = getPathLeaf(projectPath) || projectPath;
    leafCounts.set(leaf, (leafCounts.get(leaf) || 0) + 1);
  }

  return normalizedPaths.map((projectPath) => {
    const leaf = getPathLeaf(projectPath) || projectPath;
    return {
      value: projectPath,
      label: leafCounts.get(leaf)! > 1 ? projectPath : leaf,
    };
  });
}
