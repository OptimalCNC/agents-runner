import { visibleBatches, batches, projectFilters } from "../state/store.js";
import { BatchCard } from "./BatchCard.js";
import { ProjectFilter } from "./ProjectFilter.js";

export function Sidebar() {
  const visible = visibleBatches.value;
  const total = batches.value.length;
  const hasFilter = projectFilters.value.length > 0;
  const countLabel = hasFilter ? `${visible.length}/${total}` : String(total);

  return (
    <aside class="sidebar" id="sidebar">
      <div class="sidebar-header">
        <div class="sidebar-title-row">
          <h2>Batches</h2>
          <span class="badge">{countLabel}</span>
        </div>
        <div class="sidebar-filter">
          <span>Projects</span>
          <div class="sidebar-filter-chips">
            <ProjectFilter />
          </div>
        </div>
      </div>
      <div class="batches-list">
        {visible.length === 0 ? (
          <div class="empty-state">
            <div class="empty-icon">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <path d="M12 8v8M8 12h8" />
              </svg>
            </div>
            <p class="empty-title">{hasFilter ? "No matching batches" : "No batches yet"}</p>
            <p class="empty-desc">{hasFilter ? "Adjust the project filters." : "Click \"New Batch\" to get started"}</p>
          </div>
        ) : (
          visible.map((summary) => (
            <BatchCard key={summary.id} summary={summary} />
          ))
        )}
      </div>
    </aside>
  );
}
