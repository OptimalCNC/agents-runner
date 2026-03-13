import { useAppStore, selectVisibleBatches } from "../state/store.js";
import { BatchCard } from "./BatchCard.js";
import { ProjectFilter } from "./ProjectFilter.js";

export function Sidebar() {
  const visible = useAppStore(selectVisibleBatches);
  const total = useAppStore((s) => s.batches.length);
  const hasFilter = useAppStore((s) => s.projectFilters.length > 0);
  const countLabel = hasFilter ? `${visible.length}/${total}` : String(total);

  return (
    <aside className="sidebar" id="sidebar">
      <div className="sidebar-header">
        <div className="sidebar-title-row">
          <h2>Batches</h2>
          <span className="badge">{countLabel}</span>
        </div>
        <div className="sidebar-filter">
          <span>Projects</span>
          <div className="sidebar-filter-chips">
            <ProjectFilter />
          </div>
        </div>
      </div>
      <div className="batches-list">
        {visible.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <path d="M12 8v8M8 12h8" />
              </svg>
            </div>
            <p className="empty-title">{hasFilter ? "No matching batches" : "No batches yet"}</p>
            <p className="empty-desc">{hasFilter ? "Adjust the project filters." : "Click \"New Batch\" to get started"}</p>
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
