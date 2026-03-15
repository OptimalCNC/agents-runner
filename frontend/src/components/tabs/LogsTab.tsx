import { useDeferredValue, useEffect, useState } from "react";

import { SearchIcon } from "../../icons.js";
import type { Run } from "../../types.js";
import { formatDate } from "../../utils/format.js";
import { filterRunLogs } from "../../utils/logFilters.js";

interface Props {
  run: Run;
}

export function LogsTab({ run }: Props) {
  const [query, setQuery] = useState("");
  const [selectedLevels, setSelectedLevels] = useState<string[]>([]);
  const deferredQuery = useDeferredValue(query);
  const { availableLevels, totalCount, visibleCount, visibleLogs } = filterRunLogs(
    run.logs,
    selectedLevels.length > 0 ? new Set(selectedLevels) : null,
    deferredQuery,
  );
  const hasActiveFilters = selectedLevels.length > 0 || query.trim().length > 0;
  const isAllLevels = selectedLevels.length === 0;

  useEffect(() => {
    setSelectedLevels((current) => {
      const next = current.filter((level) => availableLevels.some((option) => option.level === level));
      return next.length === current.length ? current : next;
    });
  }, [availableLevels]);

  function resetFilters() {
    setQuery("");
    setSelectedLevels([]);
  }

  function toggleLevel(level: string) {
    setSelectedLevels((current) => {
      if (current.length === 0) {
        return [level];
      }

      const next = new Set(current);
      if (next.has(level)) {
        next.delete(level);
      } else {
        next.add(level);
      }

      const availableLevelValues = availableLevels.map((option) => option.level);
      if (next.size === 0) {
        return [];
      }

      if (next.size === availableLevelValues.length && availableLevelValues.every((value) => next.has(value))) {
        return [];
      }

      return availableLevelValues.filter((value) => next.has(value));
    });
  }

  return (
    <div className="tab-panel is-active run-logs-tab" data-tab="logs">
      <div className="run-logs-toolbar">
        <div className="run-logs-toolbar-row">
          <div className="run-logs-filters" role="toolbar" aria-label="Filter logs by level">
            <button
              className={`filter-chip run-logs-filter-chip${isAllLevels ? " is-active" : ""}`}
              type="button"
              aria-pressed={isAllLevels ? "true" : "false"}
              onClick={() => setSelectedLevels([])}
            >
              <span className="filter-chip-label">All</span>
              <span className="filter-chip-count">{totalCount}</span>
            </button>
            {availableLevels.map((option) => {
              const isActive = !isAllLevels && selectedLevels.includes(option.level);
              return (
                <button
                  key={option.level}
                  className={`filter-chip run-logs-filter-chip${isActive ? " is-active" : ""}`}
                  type="button"
                  aria-pressed={isActive ? "true" : "false"}
                  onClick={() => toggleLevel(option.level)}
                >
                  <span className="filter-chip-label">{option.label}</span>
                  <span className="filter-chip-count">{option.count}</span>
                </button>
              );
            })}
          </div>
          <div className="run-logs-summary form-hint">
            {visibleCount.toLocaleString()} / {totalCount.toLocaleString()} shown
          </div>
        </div>

        <div className="run-logs-toolbar-row run-logs-toolbar-search-row">
          <label className="run-logs-search">
            <span className="run-logs-search-icon" aria-hidden="true">
              <SearchIcon size={14} />
            </span>
            <input
              type="search"
              value={query}
              placeholder="Filter log messages"
              aria-label="Filter log messages"
              spellCheck={false}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <button
            className="btn btn-ghost btn-sm"
            type="button"
            disabled={!hasActiveFilters}
            onClick={resetFilters}
          >
            Clear
          </button>
        </div>
      </div>

      {totalCount === 0 ? (
        <div className="run-logs-empty text-muted text-sm">No log entries yet.</div>
      ) : visibleLogs.length === 0 ? (
        <div className="run-logs-empty text-muted text-sm">No log entries match the current filters.</div>
      ) : (
        <div className="run-logs-list">
          {visibleLogs.map(({ entry, normalizedLevel }) => (
            <div key={entry.id} className="log-entry">
              <div className="log-entry-header">
                <span className={`log-level log-level-${normalizedLevel}`}>{normalizedLevel.toUpperCase()}</span>
                <span className="log-time">{formatDate(entry.at)}</span>
              </div>
              <div className="log-msg">{entry.message}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
