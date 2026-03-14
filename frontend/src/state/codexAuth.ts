import { create } from "zustand";

import { apiLoadCodexAuthStatus } from "./api.js";
import { ensureModelCatalogLoaded } from "./modelCatalog.js";
import { useAppStore } from "./store.js";

import type { CodexAuthValidationResponse, CodexAuthValidationStatus, CodexCredentialSource } from "../types.js";

const CHECKING_MESSAGE = "Checking Codex authentication...";

export interface CodexAuthState {
  status: CodexAuthValidationStatus;
  checkedAt: string | null;
  source: CodexCredentialSource;
  authMode: string | null;
  accountLabel: string | null;
  message: string;
}

export const useCodexAuthStore = create<CodexAuthState>(() => ({
  status: "checking",
  checkedAt: null,
  source: "none",
  authMode: null,
  accountLabel: null,
  message: CHECKING_MESSAGE,
}));

let inFlight: Promise<void> | null = null;

function inferCredentialSource(): CodexCredentialSource {
  const env = useAppStore.getState().config?.codexEnvironment;
  if (env?.hasOpenAIApiKey) return "apiKey";
  if (env?.hasCodexProfile) return "profile";
  return "none";
}

function applyValidation(payload: CodexAuthValidationResponse): void {
  useCodexAuthStore.setState(payload);
  if (payload.status === "valid") {
    void ensureModelCatalogLoaded();
  }
}

export async function refreshCodexAuthValidation(): Promise<void> {
  const source = inferCredentialSource();
  if (!inFlight) {
    useCodexAuthStore.setState({
      status: "checking",
      checkedAt: null,
      source,
      authMode: null,
      accountLabel: null,
      message: CHECKING_MESSAGE,
    });

    inFlight = (async () => {
      try {
        applyValidation(await apiLoadCodexAuthStatus());
      } catch (error) {
        useCodexAuthStore.setState({
          status: "invalid",
          checkedAt: new Date().toISOString(),
          source,
          authMode: null,
          accountLabel: null,
          message: (error as Error).message || "Codex authentication validation failed.",
        });
      } finally {
        inFlight = null;
      }
    })();
  }

  await inFlight;
}
