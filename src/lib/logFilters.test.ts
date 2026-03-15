import { expect, test } from "bun:test";

import type { RunLog } from "../../frontend/src/types.js";
import { filterRunLogs, normalizeLogLevel } from "../../frontend/src/utils/logFilters.js";

function buildLog(overrides: Partial<RunLog> = {}): RunLog {
  return {
    id: "log-1",
    at: "2026-03-15T00:00:00.000Z",
    level: "info",
    message: "Default message",
    ...overrides,
  };
}

test("normalizeLogLevel canonicalizes warning aliases and blanks", () => {
  expect(normalizeLogLevel("warn")).toBe("warning");
  expect(normalizeLogLevel(" Warning ")).toBe("warning");
  expect(normalizeLogLevel("")).toBe("unknown");
});

test("filterRunLogs supports multi-select level filtering", () => {
  const logs = [
    buildLog({ id: "log-1", level: "info", message: "Started worktree" }),
    buildLog({ id: "log-2", level: "warn", message: "Retry scheduled" }),
    buildLog({ id: "log-3", level: "error", message: "Command failed" }),
  ];

  const result = filterRunLogs(logs, new Set(["warning", "error"]), "");

  expect(result.visibleLogs.map((entry) => entry.entry.id)).toEqual(["log-2", "log-3"]);
});

test("filterRunLogs keeps empty and whitespace-only queries as no-op filters", () => {
  const logs = [
    buildLog({ id: "log-1", message: "First" }),
    buildLog({ id: "log-2", level: "error", message: "Second" }),
  ];

  const result = filterRunLogs(logs, null, "   ");

  expect(result.visibleCount).toBe(2);
  expect(result.visibleLogs.map((entry) => entry.entry.id)).toEqual(["log-1", "log-2"]);
});

test("filterRunLogs matches message text case-insensitively", () => {
  const logs = [
    buildLog({ id: "log-1", message: "Created branch feature/logs" }),
    buildLog({ id: "log-2", message: "Worktree ready" }),
  ];

  const result = filterRunLogs(logs, null, "FEATURE/LOGS");

  expect(result.visibleLogs.map((entry) => entry.entry.id)).toEqual(["log-1"]);
});

test("filterRunLogs keeps unknown levels filterable and sorts them after known levels", () => {
  const logs = [
    buildLog({ id: "log-1", level: "trace", message: "Trace line" }),
    buildLog({ id: "log-2", level: "info", message: "Info line" }),
    buildLog({ id: "log-3", level: "warn", message: "Warning line" }),
    buildLog({ id: "log-4", level: "error", message: "Error line" }),
  ];

  const allLevels = filterRunLogs(logs, null, "");
  const onlyUnknown = filterRunLogs(logs, new Set(["trace"]), "");

  expect(allLevels.availableLevels.map((entry) => entry.level)).toEqual(["info", "warning", "error", "trace"]);
  expect(onlyUnknown.visibleLogs.map((entry) => entry.entry.id)).toEqual(["log-1"]);
});
