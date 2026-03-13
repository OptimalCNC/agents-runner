import { useState, useEffect } from "react";
import { useAppStore } from "../state/store.js";
import { apiInspectProject, apiSubmitBatch } from "../state/api.js";
import { deriveParentPath } from "../utils/paths.js";
import { normalizeMode, formatReasoningEffortLabel } from "../utils/format.js";
import { ModelPicker } from "./ModelPicker.js";
import { FolderBrowser, openBrowser } from "./FolderBrowser.js";
import { PlayIcon } from "../icons.js";
import type { CodexModel, ProjectContext } from "../types.js";

function getDefaultCatalogModel(models: CodexModel[]) {
  return models.find((m) => m.isDefault) ?? null;
}

function findCatalogModelByValue(value: string, models: CodexModel[]): CodexModel | null {
  const target = String(value ?? "").trim();
  if (!target) return null;
  return models.find((m) => m.model === target) ?? null;
}

function resolveDefaultBaseRef(project: ProjectContext | null | undefined): string {
  const branchName = project?.branchName?.trim();
  if (branchName) return branchName;
  return project?.headSha?.trim() || "";
}

function closeDrawer() {
  useAppStore.setState({ drawerOpen: false, modelMenuOpen: false });
  document.body.style.overflow = "";
}

export function NewBatchDrawer() {
  const isOpen = useAppStore((s) => s.drawerOpen);
  const inspect = useAppStore((s) => s.projectInspect);
  const modelCatalog = useAppStore((s) => s.modelCatalog);

  const [mode, setMode] = useState<"repeated" | "generated">("repeated");
  const [projectPath, setProjectPath] = useState("");
  const [worktreeRoot, setWorktreeRoot] = useState("");
  const [runCount, setRunCount] = useState("10");
  const [concurrency, setConcurrency] = useState("10");
  const [prompt, setPrompt] = useState("");
  const [taskPrompt, setTaskPrompt] = useState("");
  const [baseRef, setBaseRef] = useState("");
  const [model, setModel] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState("");
  const [sandboxMode, setSandboxMode] = useState("workspace-write");
  const [networkAccess, setNetworkAccess] = useState(false);
  const [webSearch, setWebSearch] = useState(false);
  const [inspectStatus, setInspectStatus] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [autoWorktreeRoot, setAutoWorktreeRoot] = useState<string | null>(null);
  const [inspectDebounce, setInspectDebounce] = useState<ReturnType<typeof setTimeout> | null>(null);
  const [browserTitle, setBrowserTitle] = useState("Choose Folder");
  const [browserTarget, setBrowserTarget] = useState<"project" | "worktree">("project");

  // Reset when drawer opens
  useEffect(() => {
    if (!isOpen) return;
    const c = useAppStore.getState().config;
    setMode("repeated");
    setProjectPath("");
    setWorktreeRoot("");
    setRunCount(String(c?.defaults?.runCount ?? 10));
    setConcurrency(String(c?.defaults?.runCount ?? 10));
    setPrompt("");
    setTaskPrompt("");
    setBaseRef("");
    setModel("");
    setReasoningEffort("");
    setSandboxMode(c?.defaults?.sandboxMode ?? "workspace-write");
    setNetworkAccess(false);
    setWebSearch(false);
    setInspectStatus("");
    setSubmitting(false);
    setAutoWorktreeRoot(null);
    useAppStore.setState({ projectInspect: null });
  }, [isOpen]);

  // Close on Escape
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape" && isOpen) closeDrawer();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [isOpen]);

  function updateWorktreeRoot(nextRoot: string) {
    const suggested = nextRoot.trim();
    const current = worktreeRoot;
    const shouldReplace = !current || current === autoWorktreeRoot;
    setAutoWorktreeRoot(suggested || null);
    if (shouldReplace) setWorktreeRoot(suggested);
  }

  function syncMaxConcurrency(count: string) {
    const n = Number(count || "1");
    if (Number(concurrency) > n) setConcurrency(String(n));
  }

  async function doInspect(path: string) {
    if (!path) {
      useAppStore.setState({ projectInspect: null });
      setBaseRef("");
      setInspectStatus("");
      return;
    }
    setInspectStatus("Inspecting\u2026");
    try {
      const payload = await apiInspectProject(path);
      const context = payload.projectContext;
      useAppStore.setState({ projectInspect: context });
      setBaseRef(resolveDefaultBaseRef(context));
      updateWorktreeRoot(deriveParentPath(context.projectPath));
      setInspectStatus("Git project ready.");
    } catch (err) {
      useAppStore.setState({ projectInspect: null });
      setBaseRef("");
      setInspectStatus((err as Error).message);
    }
  }

  function scheduleAutoInspect(path: string) {
    if (inspectDebounce) clearTimeout(inspectDebounce);
    const timer = setTimeout(() => {
      setInspectDebounce(null);
      void doInspect(path);
    }, 600);
    setInspectDebounce(timer);
  }

  function handleProjectPathChange(value: string) {
    setProjectPath(value);
    useAppStore.setState({ projectInspect: null });
    setBaseRef("");
    setInspectStatus("");
    updateWorktreeRoot(deriveParentPath(value));
    scheduleAutoInspect(value);
  }

  // Reasoning effort sync with model
  const resolvedModel = model
    ? findCatalogModelByValue(model, modelCatalog.models)
    : getDefaultCatalogModel(modelCatalog.models);
  const supportedEfforts = resolvedModel
    ? new Set(
        (resolvedModel.supportedReasoningEfforts || [])
          .map((e) => e.reasoningEffort)
          .filter((v) => v && v !== "none"),
      )
    : null;
  const defaultEffort = resolvedModel?.defaultReasoningEffort;
  const baseRefOptions: Array<{ value: string; label: string }> = [];
  const branchName = inspect?.branchName?.trim();
  const headSha = inspect?.headSha?.trim();
  if (branchName) baseRefOptions.push({ value: branchName, label: `${branchName} (branch)` });
  if (headSha) baseRefOptions.push({ value: headSha, label: `${headSha} (HEAD)` });
  if (baseRefOptions.length === 0) baseRefOptions.push({ value: "", label: "Current HEAD" });

  const canSubmit =
    projectPath.trim().length > 0 &&
    Boolean(inspect) &&
    (mode === "repeated" ? prompt.trim().length > 0 : taskPrompt.trim().length > 0);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit || submitting) return;
    setSubmitting(true);

    try {
      const payload = {
        mode,
        projectPath: projectPath.trim(),
        worktreeRoot: worktreeRoot.trim(),
        runCount: Number(runCount),
        concurrency: Number(concurrency),
        prompt: prompt.trim(),
        taskPrompt: taskPrompt.trim(),
        baseRef: baseRef.trim(),
        model: model.trim(),
        reasoningEffort,
        sandboxMode,
        networkAccessEnabled: networkAccess,
        webSearchMode: webSearch ? "live" : "disabled",
      };

      const response = await apiSubmitBatch(payload);
      const { setBatchDetail, syncSelectedBatch } = useAppStore.getState();
      useAppStore.setState({ selectedBatchId: response.batch.id, selectedRunId: null });

      const currentFilters = useAppStore.getState().projectFilters;
      if (currentFilters.length > 0 && !currentFilters.includes(response.batch.config.projectPath)) {
        useAppStore.setState({ projectFilters: [...currentFilters, response.batch.config.projectPath] });
      }

      setBatchDetail(response.batch);
      syncSelectedBatch();
      closeDrawer();
      useAppStore.getState().addToast("success", "Batch started", `${response.batch.title} is now running.`);
    } catch (err) {
      useAppStore.getState().addToast("error", "Failed to start batch", (err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  function handleBrowseProject() {
    setBrowserTitle("Choose Project Folder");
    setBrowserTarget("project");
    void openBrowser("project", projectPath);
  }

  function handleBrowseWorktree() {
    setBrowserTitle("Choose Worktree Root");
    setBrowserTarget("worktree");
    void openBrowser("worktree", worktreeRoot);
  }

  function handleBrowserSelect(path: string) {
    if (browserTarget === "project") {
      handleProjectPathChange(path);
    } else {
      setWorktreeRoot(path);
    }
  }

  return (
    <>
      <div className={`drawer-overlay${isOpen ? " is-open" : ""}`} onClick={closeDrawer} />
      <aside className={`drawer${isOpen ? " is-open" : ""}`} id="newBatchDrawer">
        <div className="drawer-header">
          <h2>New Batch</h2>
          <button className="btn-icon" type="button" aria-label="Close drawer" onClick={closeDrawer}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <form className="drawer-body" onSubmit={handleSubmit}>
          {/* Mode */}
          <div className="form-section">
            <label className="form-label">Mode</label>
            <div className="segmented">
              <button
                className={`seg-btn${mode === "repeated" ? " is-active" : ""}`}
                data-mode="repeated"
                type="button"
                onClick={() => setMode("repeated")}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="17 1 21 5 17 9" />
                  <path d="M3 11V9a4 4 0 0 1 4-4h14" />
                  <polyline points="7 23 3 19 7 15" />
                  <path d="M21 13v2a4 4 0 0 1-4 4H3" />
                </svg>
                Repeated
              </button>
              <button
                className={`seg-btn${mode === "generated" ? " is-active" : ""}`}
                data-mode="generated"
                type="button"
                onClick={() => setMode("generated")}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                </svg>
                Generated
              </button>
            </div>
          </div>

          {/* Project Folder */}
          <div className="form-section">
            <label className="form-label" htmlFor="projectPath">Project Folder</label>
            <div className="input-with-btns">
              <input
                id="projectPath"
                name="projectPath"
                value={projectPath}
                placeholder="/path/to/project"
                required
                onChange={(e) => handleProjectPathChange(e.target.value)}
              />
              <button className="btn btn-ghost btn-sm" type="button" onClick={handleBrowseProject}>Browse</button>
              <button
                className="btn-icon btn-inspect"
                type="button"
                title="Re-inspect git repository"
                aria-label="Re-inspect"
                onClick={() => doInspect(projectPath)}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
              </button>
            </div>
            <span className="form-hint">{inspectStatus}</span>
            {inspect && (
              <div className="inspect-box">
                <div className="inspect-row">
                  <span className="inspect-label">Repo root</span>
                  <span className="inspect-value">{inspect.repoRoot}</span>
                </div>
                <div className="inspect-row">
                  <span className="inspect-label">Branch</span>
                  <span className="inspect-value">{inspect.branchName || "(detached HEAD)"}</span>
                </div>
                <div className="inspect-row">
                  <span className="inspect-label">HEAD</span>
                  <span className="inspect-value mono">{inspect.headSha}</span>
                </div>
              </div>
            )}
          </div>

          {/* Base Ref */}
          <div className="form-section">
            <label className="form-label" htmlFor="baseRef">Base Ref</label>
            <select
              id="baseRef"
              name="baseRef"
              value={baseRef}
              onChange={(e) => setBaseRef(e.target.value)}
            >
              {baseRefOptions.map((option) => (
                <option key={option.value || "head"} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          {/* Worktree Root */}
          <div className="form-section">
            <label className="form-label" htmlFor="worktreeRoot">Worktree Root</label>
            <div className="input-with-btn">
              <input
                id="worktreeRoot"
                name="worktreeRoot"
                value={worktreeRoot}
                placeholder="Defaults to project parent"
                onChange={(e) => setWorktreeRoot(e.target.value)}
              />
              <button className="btn btn-ghost btn-sm" type="button" onClick={handleBrowseWorktree}>Browse</button>
            </div>
          </div>

          {/* Run Count + Concurrency */}
          <div className="form-grid-2">
            <div className="form-section">
              <label className="form-label" htmlFor="runCount">Run Count</label>
              <input
                id="runCount"
                name="runCount"
                min="1"
                max="50"
                type="number"
                value={runCount}
                required
                onChange={(e) => {
                  const v = e.target.value;
                  setRunCount(v);
                  syncMaxConcurrency(v);
                }}
              />
            </div>
            <div className="form-section">
              <label className="form-label form-label-with-hint" htmlFor="concurrency">
                Concurrency
                <span className="hint-icon" data-tooltip="Max runs executing in parallel. Cannot exceed run count." aria-label="Concurrency help">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" />
                    <path d="M12 16v-4M12 8h.01" />
                  </svg>
                </span>
              </label>
              <input
                id="concurrency"
                name="concurrency"
                min="1"
                max={runCount}
                type="number"
                value={concurrency}
                required
                onChange={(e) => setConcurrency(e.target.value)}
              />
            </div>
          </div>

          {/* Prompt / Task Prompt */}
          {mode === "repeated" ? (
            <div className="form-section">
              <label className="form-label" htmlFor="prompt">Prompt</label>
              <textarea
                id="prompt"
                name="prompt"
                rows={8}
                value={prompt}
                placeholder="Describe the task to repeat across all runs."
                onChange={(e) => setPrompt(e.target.value)}
              />
            </div>
          ) : (
            <div className="form-section">
              <label className="form-label" htmlFor="taskPrompt">Task Generation Prompt</label>
              <textarea
                id="taskPrompt"
                name="taskPrompt"
                rows={8}
                value={taskPrompt}
                placeholder="Describe how Codex should split work into independent tasks."
                onChange={(e) => setTaskPrompt(e.target.value)}
              />
            </div>
          )}

          {/* Execution Options */}
          <div className="form-divider">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            Execution Options
          </div>

          <div className="form-grid-2">
            <div className="form-section">
              <label className="form-label" htmlFor="model">Model</label>
              <ModelPicker value={model} onChange={setModel} />
            </div>
            <div className="form-section">
              <label className="form-label" htmlFor="reasoningEffort">Reasoning Effort</label>
              <select
                id="reasoningEffort"
                name="reasoningEffort"
                value={reasoningEffort}
                onChange={(e) => setReasoningEffort(e.target.value)}
              >
                <option value="">
                  {defaultEffort && defaultEffort !== "none"
                    ? `Default (${formatReasoningEffortLabel(defaultEffort)})`
                    : "Default"}
                </option>
                {[
                  { value: "minimal", label: "Minimal" },
                  { value: "low", label: "Low" },
                  { value: "medium", label: "Medium" },
                  { value: "high", label: "High" },
                  { value: "xhigh", label: "XHigh" },
                ].map(({ value: v, label }) => (
                  <option
                    key={v}
                    value={v}
                    disabled={supportedEfforts ? !supportedEfforts.has(v) : false}
                  >
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-section">
              <label className="form-label" htmlFor="sandboxMode">Sandbox</label>
              <select
                id="sandboxMode"
                name="sandboxMode"
                value={sandboxMode}
                onChange={(e) => setSandboxMode(e.target.value)}
              >
                <option value="workspace-write">workspace-write</option>
                <option value="read-only">read-only</option>
                <option value="danger-full-access">danger-full-access</option>
              </select>
            </div>
          </div>

          <div className="form-grid-2">
            <label className="toggle-field">
              <input
                type="checkbox"
                checked={networkAccess}
                onChange={(e) => setNetworkAccess(e.target.checked)}
              />
              <span className="toggle-track"><span className="toggle-thumb" /></span>
              <span>Network access</span>
            </label>
            <label className="toggle-field">
              <input
                type="checkbox"
                checked={webSearch}
                onChange={(e) => setWebSearch(e.target.checked)}
              />
              <span className="toggle-track"><span className="toggle-thumb" /></span>
              <span>Web search</span>
            </label>
          </div>

          <div className="drawer-footer">
            <button
              className="btn btn-ghost"
              type="button"
              onClick={() => {
                const c = useAppStore.getState().config;
                setMode("repeated");
                setProjectPath("");
                setWorktreeRoot("");
                setRunCount(String(c?.defaults?.runCount ?? 10));
                setConcurrency(String(c?.defaults?.runCount ?? 10));
                setPrompt("");
                setTaskPrompt("");
                setBaseRef("");
                setModel("");
                setReasoningEffort("");
                setSandboxMode(c?.defaults?.sandboxMode ?? "workspace-write");
                setNetworkAccess(false);
                setWebSearch(false);
                setInspectStatus("");
                setAutoWorktreeRoot(null);
                useAppStore.setState({ projectInspect: null });
              }}
            >
              Reset
            </button>
            <button
              className="btn btn-primary"
              type="submit"
              disabled={!canSubmit || submitting}
            >
              <PlayIcon size={16} />
              {submitting ? "Starting\u2026" : "Start Batch"}
            </button>
          </div>
        </form>
      </aside>

      <FolderBrowser title={browserTitle} onSelect={handleBrowserSelect} />
    </>
  );
}
