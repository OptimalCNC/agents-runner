import type { RunLog } from "../types.js";

export interface FilteredRunLog {
  entry: RunLog;
  normalizedLevel: string;
}

export interface LogLevelOption {
  level: string;
  label: string;
  count: number;
}

export interface FilterRunLogsResult {
  totalCount: number;
  visibleCount: number;
  availableLevels: LogLevelOption[];
  visibleLogs: FilteredRunLog[];
}

const LOG_LEVEL_ALIASES: Record<string, string> = {
  warn: "warning",
};

const LOG_LEVEL_LABELS: Record<string, string> = {
  info: "Info",
  warning: "Warning",
  error: "Error",
};

const LOG_LEVEL_ORDER = ["info", "warning", "error"] as const;

export function normalizeLogLevel(level: string | null | undefined): string {
  const normalized = String(level ?? "").trim().toLowerCase();
  if (!normalized) {
    return "unknown";
  }

  return LOG_LEVEL_ALIASES[normalized] ?? normalized;
}

export function formatLogLevelLabel(level: string): string {
  const normalized = normalizeLogLevel(level);
  return LOG_LEVEL_LABELS[normalized] ?? normalized.toUpperCase();
}

function compareLogLevels(left: string, right: string): number {
  const leftIndex = LOG_LEVEL_ORDER.indexOf(left as (typeof LOG_LEVEL_ORDER)[number]);
  const rightIndex = LOG_LEVEL_ORDER.indexOf(right as (typeof LOG_LEVEL_ORDER)[number]);

  if (leftIndex >= 0 && rightIndex >= 0) {
    return leftIndex - rightIndex;
  }

  if (leftIndex >= 0) {
    return -1;
  }

  if (rightIndex >= 0) {
    return 1;
  }

  return left.localeCompare(right);
}

export function filterRunLogs(
  logs: RunLog[],
  selectedLevels: ReadonlySet<string> | null,
  query: string,
): FilterRunLogsResult {
  const normalizedQuery = query.trim().toLowerCase();
  const levelCounts = new Map<string, number>();
  const visibleLogs: FilteredRunLog[] = [];

  for (const entry of logs) {
    const normalizedLevel = normalizeLogLevel(entry.level);
    levelCounts.set(normalizedLevel, (levelCounts.get(normalizedLevel) ?? 0) + 1);

    if (selectedLevels && selectedLevels.size > 0 && !selectedLevels.has(normalizedLevel)) {
      continue;
    }

    if (normalizedQuery && !entry.message.toLowerCase().includes(normalizedQuery)) {
      continue;
    }

    visibleLogs.push({ entry, normalizedLevel });
  }

  return {
    totalCount: logs.length,
    visibleCount: visibleLogs.length,
    availableLevels: Array.from(levelCounts.entries())
      .sort((left, right) => compareLogLevels(left[0], right[0]))
      .map(([level, count]) => ({
        level,
        label: formatLogLevelLabel(level),
        count,
      })),
    visibleLogs,
  };
}
