import { connectionStatus, config, drawerOpen, modelCatalog } from "../state/store.js";
import { PlusIcon } from "../icons.js";

function getRuntimeText() {
  const cfg = config.value;
  if (!cfg) return "Checking\u2026";
  const env = cfg.codexEnvironment;
  if (env.hasOpenAIApiKey) return "API key detected";
  if (env.hasCodexProfile) return "Codex auth";
  return "No auth";
}

function getRuntimeTitle() {
  const cfg = config.value;
  if (!cfg) return "Loading runtime info\u2026";
  const env = cfg.codexEnvironment;
  if (env.hasOpenAIApiKey) return "OPENAI_API_KEY or CODEX_API_KEY is set";
  if (env.hasCodexProfile) return "Using ~/.codex/auth.json";
  return "No API key or Codex auth profile found";
}

export function Navbar() {
  const conn = connectionStatus.value;
  const connLabel = conn === "connected" ? "Connected" : conn === "disconnected" ? "Disconnected" : "Connecting\u2026";
  const connDotClass = `conn-dot${conn === "connected" ? " is-connected" : conn === "disconnected" ? " is-error" : ""}`;

  function handleNewBatch() {
    drawerOpen.value = true;
    document.body.style.overflow = "hidden";
  }

  return (
    <nav class="navbar">
      <div class="navbar-left">
        <svg class="navbar-logo" viewBox="0 0 28 28" fill="none">
          <rect width="28" height="28" rx="7" fill="url(#logo-grad)" />
          <path d="M8 19l4-10 4 10M9.5 16h5M18 9v10" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
          <defs>
            <linearGradient id="logo-grad" x1="0" y1="0" x2="28" y2="28">
              <stop stop-color="#818cf8" />
              <stop offset="1" stop-color="#6366f1" />
            </linearGradient>
          </defs>
        </svg>
        <span class="navbar-title">Agents Runner</span>
        <span class="navbar-version">v0.1</span>
      </div>
      <div class="navbar-right">
        <div class="conn-status" id="connectionStatus">
          <span class={connDotClass} />
          <span class="conn-label">{connLabel}</span>
        </div>
        <div class="runtime-badge" title={getRuntimeTitle()}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3" />
          </svg>
          <span>{getRuntimeText()}</span>
        </div>
        <button class="btn btn-primary" type="button" onClick={handleNewBatch}>
          <PlusIcon />
          New Batch
        </button>
      </div>
    </nav>
  );
}
