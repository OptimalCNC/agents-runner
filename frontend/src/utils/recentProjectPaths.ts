const RECENT_PROJECT_PATHS_STORAGE_KEY = "agents-runner:recent-project-paths";
const RECENT_PROJECT_PATHS_LIMIT = 6;

function getStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function normalizeProjectPath(targetPath: string | null | undefined): string {
  return String(targetPath ?? "").trim();
}

export function loadRecentProjectPaths(): string[] {
  const storage = getStorage();
  if (!storage) return [];

  try {
    const raw = storage.getItem(RECENT_PROJECT_PATHS_STORAGE_KEY);
    if (!raw) return [];

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .map((entry) => normalizeProjectPath(typeof entry === "string" ? entry : ""))
      .filter(Boolean)
      .slice(0, RECENT_PROJECT_PATHS_LIMIT);
  } catch {
    return [];
  }
}

export function rememberRecentProjectPath(targetPath: string): string[] {
  const normalizedTarget = normalizeProjectPath(targetPath);
  if (!normalizedTarget) return loadRecentProjectPaths();

  const nextPaths = [
    normalizedTarget,
    ...loadRecentProjectPaths().filter((entry) => entry !== normalizedTarget),
  ].slice(0, RECENT_PROJECT_PATHS_LIMIT);

  const storage = getStorage();
  if (storage) {
    try {
      storage.setItem(RECENT_PROJECT_PATHS_STORAGE_KEY, JSON.stringify(nextPaths));
    } catch {
      // Ignore storage write failures so the form still works.
    }
  }

  return nextPaths;
}
