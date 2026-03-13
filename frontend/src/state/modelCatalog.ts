import { apiLoadModels } from "./api.js";
import { useAppStore } from "./store.js";

let inFlight: Promise<void> | null = null;

export function hasCodexModelAccess(): boolean {
  const env = useAppStore.getState().config?.codexEnvironment;
  return Boolean(env?.hasOpenAIApiKey || env?.hasCodexProfile);
}

export async function ensureModelCatalogLoaded(refresh = false): Promise<void> {
  if (!hasCodexModelAccess()) return;
  if (!refresh && useAppStore.getState().modelCatalog.loaded) return;
  if (inFlight) return inFlight;

  useAppStore.setState((s) => ({
    modelCatalog: { ...s.modelCatalog, loading: true, error: "" },
  }));

  inFlight = (async () => {
    try {
      const payload = await apiLoadModels(refresh);
      useAppStore.setState({
        modelCatalog: {
          loading: false,
          loaded: true,
          stale: Boolean(payload.stale),
          fetchedAt: payload.fetchedAt || null,
          models: Array.isArray(payload.models) ? payload.models.filter((m) => !m.hidden) : [],
          error: "",
        },
      });
    } catch (error) {
      useAppStore.setState((s) => ({
        modelCatalog: {
          ...s.modelCatalog,
          loading: false,
          error: (error as Error).message,
        },
      }));
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}
