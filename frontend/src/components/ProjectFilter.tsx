import { projectFilters, getProjectFilterOptions, syncSelectedBatch } from "../state/store.js";

export function ProjectFilter() {
  const filters = projectFilters.value;
  const options = getProjectFilterOptions();

  if (options.length === 0) {
    return <div class="filter-chip-empty">No projects yet.</div>;
  }

  function toggleFilter(value: string) {
    if (filters.includes(value)) {
      projectFilters.value = filters.filter((v) => v !== value);
    } else {
      projectFilters.value = [...filters, value];
    }
    syncSelectedBatch();
  }

  return (
    <>
      {options.map((option) => {
        const isActive = filters.includes(option.value);
        return (
          <button
            key={option.value}
            class={`filter-chip${isActive ? " is-active" : ""}`}
            type="button"
            title={option.value}
            aria-pressed={isActive ? "true" : "false"}
            onClick={() => toggleFilter(option.value)}
          >
            <span class="filter-chip-label">{option.label}</span>
          </button>
        );
      })}
    </>
  );
}
