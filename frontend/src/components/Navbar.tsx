import { useAppStore } from "../state/store.js";
import { useCodexAuthStore } from "../state/codexAuth.js";
import { PlusIcon } from "../icons.js";

export function Navbar() {
  const conn = useAppStore((s) => s.connectionStatus);
  const auth = useCodexAuthStore();

  const connLabel = conn === "connected" ? "Connected" : conn === "disconnected" ? "Disconnected" : "Connecting\u2026";
  const connDotClass = `conn-dot${conn === "connected" ? " is-connected" : conn === "disconnected" ? " is-error" : ""}`;
  const runtimeBadgeClass = `runtime-badge is-${auth.status}`;

  function handleNewBatch() {
    useAppStore.setState({ drawerOpen: true });
    document.body.style.overflow = "hidden";
  }

  return (
    <nav className="navbar">
      <div className="navbar-left">
        <svg className="navbar-logo" viewBox="0 0 28 28" fill="none">
          <rect width="28" height="28" rx="7" fill="url(#logo-grad)" />
          <path d="M8 19l4-10 4 10M9.5 16h5M18 9v10" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          <defs>
            <linearGradient id="logo-grad" x1="0" y1="0" x2="28" y2="28">
              <stop stopColor="#818cf8" />
              <stop offset="1" stopColor="#6366f1" />
            </linearGradient>
          </defs>
        </svg>
        <span className="navbar-title">Agents Runner</span>
        <span className="navbar-version">v0.1</span>
      </div>
      <div className="navbar-right">
        <div className="conn-status" id="connectionStatus">
          <span className={connDotClass} />
          <span className="conn-label">{connLabel}</span>
        </div>
        <div className={runtimeBadgeClass} title={auth.message}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3" />
          </svg>
          <span>Codex auth</span>
        </div>
        <button className="btn btn-primary" type="button" onClick={handleNewBatch}>
          <PlusIcon />
          New Batch
        </button>
      </div>
    </nav>
  );
}
