import { signal } from "@preact/signals";

import { apiValidateCodexAuth } from "./api.js";
import { ensureModelCatalogLoaded } from "./modelCatalog.js";
import { config } from "./store.js";

import type { CodexAuthValidationResponse, CodexAuthValidationStatus, CodexCredentialSource } from "../types.js";

const CHECKING_MESSAGE = "Checking Codex authentication...";

export interface CodexAuthState {
  status: CodexAuthValidationStatus;
  checkedAt: string | null;
  source: CodexCredentialSource;
  message: string;
}

export const codexAuth = signal<CodexAuthState>({
  status: "checking",
  checkedAt: null,
  source: "none",
  message: CHECKING_MESSAGE,
});

let inFlight: Promise<void> | null = null;

function inferCredentialSource(): CodexCredentialSource {
  const env = config.value?.codexEnvironment;
  if (env?.hasOpenAIApiKey) return "apiKey";
  if (env?.hasCodexProfile) return "profile";
  return "none";
}

function applyValidation(payload: CodexAuthValidationResponse): void {
  codexAuth.value = payload;
  if (payload.status === "valid") {
    void ensureModelCatalogLoaded();
  }
}

export async function refreshCodexAuthValidation(): Promise<void> {
  const source = inferCredentialSource();
  if (!inFlight) {
    codexAuth.value = {
      status: "checking",
      checkedAt: null,
      source,
      message: CHECKING_MESSAGE,
    };

    inFlight = (async () => {
      try {
        applyValidation(await apiValidateCodexAuth());
      } catch (error) {
        codexAuth.value = {
          status: "invalid",
          checkedAt: new Date().toISOString(),
          source,
          message: (error as Error).message || "Codex authentication validation failed.",
        };
      } finally {
        inFlight = null;
      }
    })();
  }

  await inFlight;
}
