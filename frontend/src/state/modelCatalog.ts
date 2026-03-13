import { apiLoadModels } from "./api.js";
import { config, modelCatalog } from "./store.js";

let inFlight: Promise<void> | null = null;

export function hasCodexModelAccess(): boolean {
  const env = config.value?.codexEnvironment;
  return Boolean(env?.hasOpenAIApiKey || env?.hasCodexProfile);
}

export async function ensureModelCatalogLoaded(refresh = false): Promise<void> {
  if (!hasCodexModelAccess()) return;
  if (!refresh && modelCatalog.value.loaded) return;
  if (inFlight) return inFlight;

  modelCatalog.value = { ...modelCatalog.value, loading: true, error: "" };
  inFlight = (async () => {
    try {
      const payload = await apiLoadModels(refresh);
      modelCatalog.value = {
        loading: false,
        loaded: true,
        stale: Boolean(payload.stale),
        fetchedAt: payload.fetchedAt || null,
        models: Array.isArray(payload.models) ? payload.models.filter((m) => !m.hidden) : [],
        error: "",
      };
    } catch (error) {
      modelCatalog.value = {
        ...modelCatalog.value,
        loading: false,
        error: (error as Error).message,
      };
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}
