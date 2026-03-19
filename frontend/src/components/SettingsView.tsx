import { useEffect, useState } from "react";

import { FolderBrowser, openBrowser } from "../dialogs/FolderBrowser.js";
import {
  AlertIcon,
  CheckCircleIcon,
  FolderIcon,
  GitIcon,
  InfoIcon,
  RefreshIcon,
  SettingsIcon,
  TerminalIcon,
  WrenchIcon,
  XCircleIcon,
} from "../icons.js";
import { apiGetBundledMcpStatus, apiInstallBundledMcp, apiUpdateConfig } from "../state/api.js";
import { useAppStore } from "../state/store.js";
import type { AppConfig, BundledMcpStatus } from "../types.js";
import { detectClientPlatform } from "../utils/clientPlatform.js";
import { resolveTerminalLaunchState } from "../utils/terminalLaunch.js";

type HealthTone = "healthy" | "warning" | "idle";
type InlineNoteState = {
  tone: "success" | "error";
  message: string;
} | null;

function getMcpHealthTone(status: BundledMcpStatus | null): HealthTone {
  if (!status) {
    return "idle";
  }

  if (status.healthy) {
    return "healthy";
  }

  return status.installed ? "warning" : "idle";
}

function getMcpHealthLabel(status: BundledMcpStatus | null): string {
  if (!status) {
    return "Checking";
  }

  if (status.healthy) {
    return "Ready";
  }

  return status.installed ? "Needs repair" : "Not installed";
}

function getMcpHealthSummary(status: BundledMcpStatus | null): string {
  if (!status) {
    return "Checking the current Codex MCP configuration for Agents Runner.";
  }

  if (status.healthy) {
    return `Codex is already configured to use ${status.serverName} at ${status.endpointUrl}.`;
  }

  if (status.installed) {
    return status.error || `Codex has ${status.serverName} configured, but it needs to be repaired.`;
  }

  return `Install ${status.serverName} so Review can create commits through the bundled MCP server.`;
}

function formatTransport(transport: BundledMcpStatus["transport"]): string {
  if (transport === "streamable_http") {
    return "streamable HTTP";
  }

  if (transport === "stdio") {
    return "stdio";
  }

  return "not configured";
}

function getTerminalPreferenceLabel(preference: AppConfig["terminal"]["preference"]): string {
  return preference === "windows-terminal" ? "Windows Terminal" : "Auto";
}

function getTerminalSummary(config: AppConfig | null, clientPlatform: ReturnType<typeof detectClientPlatform>, note: InlineNoteState): string {
  if (note?.message) {
    return note.message;
  }

  if (!config) {
    return "Choose how Agents Runner opens a native terminal window for a run folder.";
  }

  const launchState = resolveTerminalLaunchState(config, clientPlatform, config.homeDirectory || "/");
  if (config.terminal.preference === "auto") {
    return launchState.canLaunch
      ? `Auto currently resolves to ${launchState.effectiveLauncherLabel} for this browser.`
      : launchState.disabledReason;
  }

  return launchState.canLaunch
    ? `${launchState.effectiveLauncherLabel} will be used when you open a run folder in a terminal.`
    : launchState.disabledReason;
}

export function SettingsView() {
  const config = useAppStore((s) => s.config);
  const savedWorktreeRoot = config?.defaults?.worktreeRoot ?? "";
  const savedTerminalPreference = config?.terminal.preference ?? "auto";
  const clientPlatform = detectClientPlatform();
  const windowsTerminal = config?.terminal.launchers.find((launcher) => launcher.id === "windows-terminal") ?? null;

  const [status, setStatus] = useState<BundledMcpStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState("");
  const [defaultWorktreeRoot, setDefaultWorktreeRoot] = useState(savedWorktreeRoot);
  const [savingDefaults, setSavingDefaults] = useState(false);
  const [defaultsNote, setDefaultsNote] = useState<InlineNoteState>(null);
  const [terminalPreference, setTerminalPreference] = useState<AppConfig["terminal"]["preference"]>(savedTerminalPreference);
  const [savingTerminal, setSavingTerminal] = useState(false);
  const [terminalNote, setTerminalNote] = useState<InlineNoteState>(null);

  useEffect(() => {
    void loadStatus();
  }, []);

  useEffect(() => {
    setDefaultWorktreeRoot(savedWorktreeRoot);
  }, [savedWorktreeRoot]);

  useEffect(() => {
    setTerminalPreference(savedTerminalPreference);
  }, [savedTerminalPreference]);

  useEffect(() => () => {
    useAppStore.setState({ browserDialogOpen: false });
  }, []);

  async function loadStatus(): Promise<void> {
    setLoading(true);
    setError("");

    try {
      const payload = await apiGetBundledMcpStatus();
      setStatus(payload.status);
    } catch (nextError) {
      setError((nextError as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function handleInstall(): Promise<void> {
    setInstalling(true);
    setError("");

    try {
      const payload = await apiInstallBundledMcp();
      setStatus(payload.status);

      if (!payload.status.healthy) {
        throw new Error(payload.status.error || "Agents Runner could not verify the MCP install.");
      }

      useAppStore.getState().addToast(
        "success",
        "MCP installed",
        `Codex now points ${payload.status.serverName} at ${payload.status.endpointUrl}.`,
      );
    } catch (nextError) {
      const message = (nextError as Error).message;
      setError(message);
      useAppStore.getState().addToast("error", "MCP install failed", message);
    } finally {
      setInstalling(false);
    }
  }

  async function handleSaveDefaults(): Promise<void> {
    if (!config || savingDefaults) {
      return;
    }

    setSavingDefaults(true);
    setDefaultsNote(null);

    try {
      const nextConfig = await apiUpdateConfig({
        worktreeRoot: defaultWorktreeRoot.trim(),
      });

      useAppStore.setState({ config: nextConfig });
      setDefaultsNote({
        tone: "success",
        message: nextConfig.defaults.worktreeRoot
          ? `New batches will start with ${nextConfig.defaults.worktreeRoot} as the worktree root.`
          : "New batches will fall back to each project's parent folder.",
      });
      useAppStore.getState().addToast("success", "Defaults saved", "Batch defaults were updated.");
    } catch (nextError) {
      const message = (nextError as Error).message;
      setDefaultsNote({
        tone: "error",
        message,
      });
      useAppStore.getState().addToast("error", "Failed to save defaults", message);
    } finally {
      setSavingDefaults(false);
    }
  }

  async function handleSaveTerminal(): Promise<void> {
    if (!config || savingTerminal) {
      return;
    }

    setSavingTerminal(true);
    setTerminalNote(null);

    try {
      const nextConfig = await apiUpdateConfig({
        terminalPreference,
      });

      useAppStore.setState({ config: nextConfig });
      setTerminalNote({
        tone: "success",
        message: `${getTerminalPreferenceLabel(nextConfig.terminal.preference)} is now the saved terminal launcher preference.`,
      });
      useAppStore.getState().addToast("success", "Terminal launcher saved", "Run Details will use the updated launcher preference.");
    } catch (nextError) {
      const message = (nextError as Error).message;
      setTerminalNote({
        tone: "error",
        message,
      });
      useAppStore.getState().addToast("error", "Failed to save terminal launcher", message);
    } finally {
      setSavingTerminal(false);
    }
  }

  function handleBrowseDefaultWorktree(): void {
    void openBrowser("worktree", defaultWorktreeRoot || savedWorktreeRoot || config?.homeDirectory || "");
  }

  function handleDefaultWorktreeSelect(path: string): void {
    setDefaultWorktreeRoot(path);
    setDefaultsNote(null);
  }

  const healthTone = getMcpHealthTone(status);
  const healthLabel = getMcpHealthLabel(status);
  const healthSummary = getMcpHealthSummary(status);
  const installLabel = installing
    ? (status?.installed ? "Repairing..." : "Installing...")
    : status?.installed
      ? (status.healthy ? "Reinstall MCP" : "Repair MCP")
      : "Install MCP";
  const installCommand = status
    ? [
      `codex mcp remove ${status.serverName}`,
      `codex mcp add ${status.serverName} --url ${status.endpointUrl}`,
    ].join("\n")
    : "";
  const defaultWorktreeDirty = defaultWorktreeRoot.trim() !== savedWorktreeRoot;
  const worktreeHealthTone: HealthTone = savedWorktreeRoot ? "healthy" : "idle";
  const worktreeHealthLabel = savedWorktreeRoot ? "Configured" : "Project Parent";
  const defaultsSummary = defaultsNote?.message
    || "Leave this blank to keep using each project's parent folder. You can still override the worktree root per batch.";
  const terminalDirty = terminalPreference !== savedTerminalPreference;
  const terminalProbeConfig = config
    ? {
      ...config,
      terminal: {
        ...config.terminal,
        preference: terminalPreference,
      },
    }
    : null;
  const terminalLaunchState = resolveTerminalLaunchState(terminalProbeConfig, clientPlatform, config?.homeDirectory || "/");
  const terminalHealthTone: HealthTone = terminalLaunchState.canLaunch ? "healthy" : "warning";
  const terminalHealthLabel = terminalLaunchState.canLaunch
    ? "Ready"
    : windowsTerminal?.supported
      ? "Needs Windows Browser"
      : "Unavailable";
  const terminalSummary = getTerminalSummary(terminalProbeConfig, clientPlatform, terminalNote);

  return (
    <div className="settings-page">
      <header className="settings-hero">
        <div className="settings-hero-badge">
          <SettingsIcon size={14} />
          Settings
        </div>
        <h1>Settings</h1>
        <p>
          Manage batch defaults and the local Codex integration that Agents Runner uses for Review commits.
        </p>
      </header>

      <section className="settings-card">
        <div className="settings-card-header">
          <div className="settings-card-heading">
            <div className={`settings-health-pill is-${worktreeHealthTone}`}>
              {savedWorktreeRoot ? <CheckCircleIcon size={14} /> : <FolderIcon size={14} />}
              {worktreeHealthLabel}
            </div>
            <div>
              <h2>Batch Defaults</h2>
              <p>
                Set one shared base folder for git worktrees. New batch drawers will start with this path, while each batch can still override it.
              </p>
            </div>
          </div>
          <div className="settings-card-actions">
            <button
              className="btn btn-ghost"
              type="button"
              onClick={() => {
                setDefaultWorktreeRoot("");
                setDefaultsNote(null);
              }}
              disabled={savingDefaults || defaultWorktreeRoot.trim().length === 0}
            >
              Clear
            </button>
            <button
              className="btn btn-primary"
              type="button"
              onClick={() => void handleSaveDefaults()}
              disabled={!config || savingDefaults || !defaultWorktreeDirty}
            >
              <FolderIcon size={13} />
              {savingDefaults ? "Saving..." : "Save Defaults"}
            </button>
          </div>
        </div>

        <div className={`settings-inline-note${defaultsNote ? ` is-${defaultsNote.tone}` : ""}`}>
          {defaultsSummary}
        </div>

        <div className="settings-subsection">
          <div className="settings-subsection-header">
            <div>
              <h3>Common Worktree Folder</h3>
              <p>
                When this is set, Agents Runner uses it as the initial worktree root for new batches instead of the inspected project's parent folder.
              </p>
            </div>
            <div className="settings-subsection-icon">
              {savedWorktreeRoot ? <CheckCircleIcon size={18} /> : <InfoIcon size={18} />}
            </div>
          </div>

          <div className="form-section">
            <label className="form-label" htmlFor="defaultWorktreeRoot">Base Worktree Folder</label>
            <div className="input-with-btns">
              <input
                id="defaultWorktreeRoot"
                name="defaultWorktreeRoot"
                value={defaultWorktreeRoot}
                placeholder="Leave blank to use project parent"
                onChange={(event) => {
                  setDefaultWorktreeRoot(event.target.value);
                  setDefaultsNote(null);
                }}
              />
              <button className="btn btn-ghost btn-sm" type="button" onClick={handleBrowseDefaultWorktree}>
                Browse
              </button>
            </div>
            <span className="form-hint">
              Saved value: {savedWorktreeRoot || "Project parent fallback"}
            </span>
          </div>
        </div>
      </section>

      <section className="settings-card">
        <div className="settings-card-header">
          <div className="settings-card-heading">
            <div className={`settings-health-pill is-${terminalHealthTone}`}>
              {terminalLaunchState.canLaunch ? <TerminalIcon size={14} /> : <AlertIcon size={14} />}
              {terminalHealthLabel}
            </div>
            <div>
              <h2>Terminal Launcher</h2>
              <p>
                Choose which native terminal app Run Details should launch. Each click opens a new terminal window and Agents Runner does not manage its lifetime.
              </p>
            </div>
          </div>
          <div className="settings-card-actions">
            <button
              className="btn btn-primary"
              type="button"
              onClick={() => void handleSaveTerminal()}
              disabled={!config || savingTerminal || !terminalDirty}
            >
              <TerminalIcon size={13} />
              {savingTerminal ? "Saving..." : "Save Terminal"}
            </button>
          </div>
        </div>

        <div className={`settings-inline-note${terminalNote ? ` is-${terminalNote.tone}` : terminalLaunchState.canLaunch ? " is-success" : " is-warning"}`}>
          {terminalSummary}
        </div>

        <div className="settings-detail-grid">
          <article className="settings-detail-card">
            <div className="settings-detail-label">Current browser</div>
            <div className="settings-detail-value">{clientPlatform}</div>
          </article>
          <article className="settings-detail-card">
            <div className="settings-detail-label">Saved preference</div>
            <div className="settings-detail-value">{getTerminalPreferenceLabel(savedTerminalPreference)}</div>
          </article>
          <article className="settings-detail-card">
            <div className="settings-detail-label">Windows Terminal</div>
            <div className="settings-detail-value">{windowsTerminal?.supported ? "Available" : windowsTerminal?.unsupportedReason || "Unavailable"}</div>
          </article>
        </div>

        <div className="settings-subsection">
          <div className="settings-subsection-header">
            <div>
              <h3>Launcher Preference</h3>
              <p>
                Auto uses Windows Terminal only when the page is opened from Windows. You can still force Windows Terminal explicitly.
              </p>
            </div>
            <div className="settings-subsection-icon">
              {terminalLaunchState.canLaunch ? <TerminalIcon size={18} /> : <AlertIcon size={18} />}
            </div>
          </div>

          <div className="form-section">
            <label className="form-label" htmlFor="terminalPreference">Terminal Application</label>
            <select
              id="terminalPreference"
              name="terminalPreference"
              value={terminalPreference}
              onChange={(event) => {
                setTerminalPreference(event.target.value as AppConfig["terminal"]["preference"]);
                setTerminalNote(null);
              }}
            >
              <option value="auto">Auto</option>
              <option value="windows-terminal">Windows Terminal</option>
            </select>
            <span className="form-hint">
              Saved value: {getTerminalPreferenceLabel(savedTerminalPreference)}
            </span>
          </div>
        </div>
      </section>

      <section className="settings-card">
        <div className="settings-card-header">
          <div className="settings-card-heading">
            <div className={`settings-health-pill is-${healthTone}`}>
              {status?.healthy ? <CheckCircleIcon size={14} /> : status?.installed ? <WrenchIcon size={14} /> : <InfoIcon size={14} />}
              {healthLabel}
            </div>
            <div>
              <h2>Bundled Git MCP</h2>
              <p>
                Review installs one global Codex MCP entry named <span className="mono">{status?.serverName || "agents-runner-workflow"}</span>.
                It points back to this Agents Runner instance so Codex can create commits without broader sandbox access.
              </p>
            </div>
          </div>
          <div className="settings-card-actions">
            <button className="btn btn-ghost" type="button" onClick={() => void loadStatus()} disabled={loading || installing}>
              <RefreshIcon size={13} />
              {loading ? "Refreshing..." : "Refresh"}
            </button>
            <button className="btn btn-primary" type="button" onClick={() => void handleInstall()} disabled={loading || installing || !status}>
              <GitIcon size={13} />
              {installLabel}
            </button>
          </div>
        </div>

        <div className={`settings-inline-note${error ? " is-error" : status?.healthy ? " is-success" : status?.installed ? " is-warning" : ""}`}>
          {error || healthSummary}
        </div>

        {loading ? (
          <div className="settings-loading">
            <RefreshIcon size={14} />
            Checking bundled MCP status...
          </div>
        ) : status ? (
          <>
            <div className="settings-detail-grid">
              <article className="settings-detail-card">
                <div className="settings-detail-label">Server name</div>
                <div className="settings-detail-value mono">{status.serverName}</div>
              </article>
              <article className="settings-detail-card">
                <div className="settings-detail-label">Expected endpoint</div>
                <div className="settings-detail-value mono settings-break">{status.endpointUrl}</div>
              </article>
              <article className="settings-detail-card">
                <div className="settings-detail-label">Configured URL</div>
                <div className="settings-detail-value mono settings-break">
                  {status.configuredUrl || "Not present in Codex config"}
                </div>
              </article>
              <article className="settings-detail-card">
                <div className="settings-detail-label">Transport</div>
                <div className="settings-detail-value">{formatTransport(status.transport)}</div>
              </article>
              <article className="settings-detail-card">
                <div className="settings-detail-label">Codex config</div>
                <div className="settings-detail-value mono settings-break">{status.configPath}</div>
              </article>
              <article className="settings-detail-card">
                <div className="settings-detail-label">Status</div>
                <div className="settings-detail-value">
                  {status.healthy
                    ? "Installed and healthy"
                    : status.installed
                      ? "Installed but needs repair"
                      : "Not installed"}
                </div>
              </article>
            </div>

            <div className="settings-subsection">
              <div className="settings-subsection-header">
                <div>
                  <h3>Manual command</h3>
                  <p>
                    Agents Runner can install this for you, but this is the exact Codex CLI sequence it uses.
                  </p>
                </div>
                <div className="settings-subsection-icon">
                  {status.healthy ? <CheckCircleIcon size={18} /> : status.installed ? <AlertIcon size={18} /> : <XCircleIcon size={18} />}
                </div>
              </div>
              <pre className="code-block settings-command-block">{installCommand}</pre>
            </div>
          </>
        ) : (
          <div className="settings-loading">
            <InfoIcon size={14} />
            MCP status is unavailable right now.
          </div>
        )}
      </section>

      <FolderBrowser title="Choose Default Worktree Folder" onSelect={handleDefaultWorktreeSelect} />
    </div>
  );
}
