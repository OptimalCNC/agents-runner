import { useAppStore, getProjectFilterOptions } from "../state/store.js";

export function ProjectFilter() {
  const filters = useAppStore((s) => s.projectFilters);
  const batches = useAppStore((s) => s.batches);
  const options = getProjectFilterOptions(batches);

  if (options.length === 0) {
    return <div className="filter-chip-empty">No projects yet.</div>;
  }

  function toggleFilter(value: string) {
    const next = filters.includes(value)
      ? filters.filter((v) => v !== value)
      : [...filters, value];
    useAppStore.getState().setProjectFilters(next);
  }

  return (
    <>
      {options.map((option) => {
        const isActive = filters.includes(option.value);
        return (
          <button
            key={option.value}
            className={`filter-chip${isActive ? " is-active" : ""}`}
            type="button"
            title={option.value}
            aria-pressed={isActive ? "true" : "false"}
            onClick={() => toggleFilter(option.value)}
          >
            <span className="filter-chip-label">{option.label}</span>
          </button>
        );
      })}
    </>
  );
}
