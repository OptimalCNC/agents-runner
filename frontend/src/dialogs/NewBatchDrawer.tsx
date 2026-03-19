import { useState, useEffect } from "react";
import { useAppStore } from "../state/store.js";
import { apiInspectProject, apiSubmitBatch } from "../state/api.js";
import { buildProjectPathOptions, deriveParentPath } from "../utils/paths.js";
import { formatReasoningEffortLabel } from "../utils/format.js";
import { loadRecentProjectPaths, rememberRecentProjectPath } from "../utils/recentProjectPaths.js";
import { ModelPicker } from "./ModelPicker.js";
import { FolderBrowser, openBrowser } from "./FolderBrowser.js";
import { PlayIcon } from "../icons.js";
import type { AppConfig, BatchMode, CodexModel, NewBatchDraft, ProjectContext } from "../types.js";
import { getWorkflowUI, getAllWorkflowUIs } from "../workflows/registry.js";

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
  useAppStore.setState({
    drawerOpen: false,
    modelMenuOpen: false,
    newBatchDraft: null,
    browserDialogOpen: false,
  });
  document.body.style.overflow = "";
}

export const DEFAULT_RANKED_REVIEW_PROMPT = "Review the implementation on the task branch against the base branch. Score it from 0 to 100, prioritizing correctness, task completion, code quality, and regression risk. Penalize incomplete work, broken behavior, and unnecessary changes.";

interface InitialDrawerState {
  mode: BatchMode;
  projectPath: string;
  worktreeRoot: string;
  runCount: string;
  concurrency: string;
  prompt: string;
  taskPrompt: string;
  reviewPrompt: string;
  reviewCount: string;
  baseRef: string;
  model: string;
  reasoningEffort: string;
  sandboxMode: string;
  networkAccess: boolean;
  webSearch: boolean;
}

export function getDefaultReviewPrompt(mode: BatchMode): string {
  return mode === "ranked" ? DEFAULT_RANKED_REVIEW_PROMPT : "";
}

export function resolveReviewPromptForModeChange(currentMode: BatchMode, nextMode: BatchMode, reviewPrompt: string): string {
  const currentDefault = getDefaultReviewPrompt(currentMode).trim();
  if (!reviewPrompt.trim() || reviewPrompt.trim() === currentDefault) {
    return getDefaultReviewPrompt(nextMode);
  }
  return reviewPrompt;
}

function buildDefaultNewBatchDraft(config: AppConfig | null): NewBatchDraft {
  const defaultRunCount = Math.max(1, config?.defaults?.runCount ?? 10);
  return {
    mode: "repeated",
    config: {
      runCount: defaultRunCount,
      concurrency: defaultRunCount,
      reviewCount: 3,
      projectPath: "",
      worktreeRoot: config?.defaults?.worktreeRoot ?? "",
      prompt: "",
      taskPrompt: "",
      reviewPrompt: getDefaultReviewPrompt("repeated"),
      baseRef: "",
      model: "",
      sandboxMode: config?.defaults?.sandboxMode ?? "workspace-write",
      networkAccessEnabled: false,
      webSearchMode: "disabled",
      reasoningEffort: "",
    },
  };
}

export function buildInitialDrawerState(config: AppConfig | null, draft: NewBatchDraft | null): InitialDrawerState {
  const source = draft ?? buildDefaultNewBatchDraft(config);
  const runCount = Math.max(1, source.config.runCount || 1);
  const reviewCount = Math.max(1, source.config.reviewCount || 1);
  const concurrencyLimit = getWorkflowUI(source.mode).getMaxConcurrency(runCount, reviewCount);
  const concurrency = Math.max(1, Math.min(source.config.concurrency || runCount, concurrencyLimit));

  return {
    mode: source.mode,
    projectPath: source.config.projectPath,
    worktreeRoot: source.config.worktreeRoot,
    runCount: String(runCount),
    concurrency: String(concurrency),
    prompt: source.config.prompt,
    taskPrompt: source.config.taskPrompt,
    reviewPrompt: source.config.reviewPrompt || getDefaultReviewPrompt(source.mode),
    reviewCount: String(reviewCount),
    baseRef: source.config.baseRef,
    model: source.config.model,
    reasoningEffort: source.config.reasoningEffort,
    sandboxMode: source.config.sandboxMode || config?.defaults?.sandboxMode || "workspace-write",
    networkAccess: source.config.networkAccessEnabled,
    webSearch: source.config.webSearchMode === "live",
  };
}


export function NewBatchDrawer() {
  const isOpen = useAppStore((s) => s.drawerOpen);
  const batches = useAppStore((s) => s.batches);
  const inspect = useAppStore((s) => s.projectInspect);
  const modelCatalog = useAppStore((s) => s.modelCatalog);

  const [mode, setMode] = useState<BatchMode>("repeated");
  const [projectPath, setProjectPath] = useState("");
  const [recentProjectPaths, setRecentProjectPaths] = useState<string[]>([]);
  const [worktreeRoot, setWorktreeRoot] = useState("");
  const [runCount, setRunCount] = useState("10");
  const [concurrency, setConcurrency] = useState("10");
  const [prompt, setPrompt] = useState("");
  const [taskPrompt, setTaskPrompt] = useState("");
  const [reviewPrompt, setReviewPrompt] = useState(getDefaultReviewPrompt("repeated"));
  const [reviewCount, setReviewCount] = useState("3");
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
  const [initialInspectRequest, setInitialInspectRequest] = useState<{ path: string; preferredBaseRef: string } | null>(null);
  const [browserTitle, setBrowserTitle] = useState("Choose Folder");
  const [browserTarget, setBrowserTarget] = useState<"project" | "worktree">("project");

  // Reset when drawer opens
  useEffect(() => {
    if (!isOpen) return;
    if (inspectDebounce) {
      clearTimeout(inspectDebounce);
      setInspectDebounce(null);
    }

    const store = useAppStore.getState();
    const c = store.config;
    const draft = store.newBatchDraft;
    const initialState = buildInitialDrawerState(c, draft);
    setMode(initialState.mode);
    setProjectPath(initialState.projectPath);
    setRecentProjectPaths(loadRecentProjectPaths());
    setWorktreeRoot(initialState.worktreeRoot);
    setRunCount(initialState.runCount);
    setConcurrency(initialState.concurrency);
    setPrompt(initialState.prompt);
    setTaskPrompt(initialState.taskPrompt);
    setReviewPrompt(initialState.reviewPrompt);
    setReviewCount(initialState.reviewCount);
    setBaseRef(initialState.baseRef);
    setModel(initialState.model);
    setReasoningEffort(initialState.reasoningEffort);
    setSandboxMode(initialState.sandboxMode);
    setNetworkAccess(initialState.networkAccess);
    setWebSearch(initialState.webSearch);
    setInspectStatus("");
    setSubmitting(false);
    setAutoWorktreeRoot(null);
    setInitialInspectRequest(
      initialState.projectPath.trim()
        ? { path: initialState.projectPath, preferredBaseRef: initialState.baseRef.trim() }
        : null,
    );
    useAppStore.setState({ projectInspect: null });
    store.clearNewBatchDraft();
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !initialInspectRequest) return;
    void doInspect(initialInspectRequest.path, initialInspectRequest.preferredBaseRef);
    setInitialInspectRequest(null);
  }, [isOpen, initialInspectRequest]);

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

  function rememberProjectPath(path: string) {
    setRecentProjectPaths(rememberRecentProjectPath(path));
  }

  function syncMaxConcurrency(
    nextRunCount: string,
    nextMode: BatchMode = mode,
    nextReviewCount: string = reviewCount,
  ) {
    const runCountInt = Math.max(1, Number.parseInt(nextRunCount || "1", 10) || 1);
    const reviewCountInt = Math.max(1, Number.parseInt(nextReviewCount || "1", 10) || 1);
    const max = getWorkflowUI(nextMode).getMaxConcurrency(runCountInt, reviewCountInt);
    if (Number(concurrency) > max) setConcurrency(String(max));
  }

  function handleReviewCountChange(value: string) {
    setReviewCount(value);
    syncMaxConcurrency(runCount, mode, value);
  }

  function clampConcurrencyInput(value: string) {
    const runCountInt = Math.max(1, Number.parseInt(runCount || "1", 10) || 1);
    const reviewCountInt = Math.max(1, Number.parseInt(reviewCount || "1", 10) || 1);
    const max = getWorkflowUI(mode).getMaxConcurrency(runCountInt, reviewCountInt);
    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed)) {
      setConcurrency(String(max));
      return;
    }

    setConcurrency(String(Math.max(1, Math.min(parsed, max))));
  }

  function handleModeChange(nextMode: BatchMode) {
    if (nextMode === mode) return;
    setReviewPrompt((current) => resolveReviewPromptForModeChange(mode, nextMode, current));
    setMode(nextMode);
    syncMaxConcurrency(runCount, nextMode);
  }

  async function doInspect(path: string, preferredBaseRef = "") {
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
      rememberProjectPath(context.projectPath);
      setBaseRef(preferredBaseRef || resolveDefaultBaseRef(context));
      updateWorktreeRoot(deriveParentPath(context.projectPath));
      setInspectStatus("Git project ready.");
    } catch (err) {
      useAppStore.setState({ projectInspect: null });
      setBaseRef(preferredBaseRef);
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
    setInitialInspectRequest(null);
    useAppStore.setState({ projectInspect: null });
    setBaseRef("");
    setInspectStatus("");
    updateWorktreeRoot(deriveParentPath(value));
    scheduleAutoInspect(value);
  }

  function handleRecentProjectSelect(value: string) {
    rememberProjectPath(value);
    handleProjectPathChange(value);
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
  const recentProjectOptions = buildProjectPathOptions([
    ...recentProjectPaths,
    ...batches.map((batch) => batch.config.projectPath),
  ])
    .filter((option) => option.value !== projectPath.trim())
    .slice(0, 6);
  if (branchName) baseRefOptions.push({ value: branchName, label: `${branchName} (branch)` });
  if (headSha) baseRefOptions.push({ value: headSha, label: `${headSha} (HEAD)` });
  if (baseRefOptions.length === 0) baseRefOptions.push({ value: "", label: "Current HEAD" });

  const workflow = getWorkflowUI(mode);
  const runCountInt = Math.max(1, Number.parseInt(runCount || "1", 10) || 1);
  const reviewCountInt = Math.max(1, Number.parseInt(reviewCount || "1", 10) || 1);
  const concurrencyLimit = workflow.getMaxConcurrency(runCountInt, reviewCountInt);
  const concurrencyHint = workflow.getConcurrencyHint(concurrencyLimit);
  const canSubmit =
    projectPath.trim().length > 0 &&
    Boolean(inspect) &&
    workflow.canSubmit({ prompt, taskPrompt, reviewPrompt });

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit || submitting) return;
    setSubmitting(true);

    try {
      const normalizedRunCount = Math.max(1, Number.parseInt(runCount || "1", 10) || 1);
      const normalizedReviewCount = Math.max(1, Number.parseInt(reviewCount || "1", 10) || 1);
      const maxConcurrency = getWorkflowUI(mode).getMaxConcurrency(normalizedRunCount, normalizedReviewCount);
      const normalizedConcurrency = Math.max(
        1,
        Math.min(Number.parseInt(concurrency || String(normalizedRunCount), 10) || normalizedRunCount, maxConcurrency),
      );

      const payload = {
        mode,
        projectPath: projectPath.trim(),
        worktreeRoot: worktreeRoot.trim(),
        runCount: normalizedRunCount,
        concurrency: normalizedConcurrency,
        prompt: prompt.trim(),
        taskPrompt: taskPrompt.trim(),
        reviewPrompt: reviewPrompt.trim(),
        reviewCount: normalizedReviewCount,
        baseRef: baseRef.trim(),
        model: model.trim(),
        reasoningEffort,
        sandboxMode,
        networkAccessEnabled: networkAccess,
        webSearchMode: webSearch ? "live" : "disabled",
      };

      const response = await apiSubmitBatch(payload);
      const { setBatchDetail, selectBatch, setProjectFilters } = useAppStore.getState();
      rememberProjectPath(response.batch.config.projectPath);
      setBatchDetail(response.batch);

      const currentFilters = useAppStore.getState().projectFilters;
      if (currentFilters.length > 0 && !currentFilters.includes(response.batch.config.projectPath)) {
        setProjectFilters([...currentFilters, response.batch.config.projectPath]);
      }

      selectBatch(response.batch.id);
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
              {getAllWorkflowUIs().map((wf) => (
                <button
                  key={wf.mode}
                  className={`seg-btn${mode === wf.mode ? " is-active" : ""}`}
                  data-mode={wf.mode}
                  type="button"
                  onClick={() => handleModeChange(wf.mode)}
                >
                  <wf.Icon />
                  {wf.label}
                </button>
              ))}
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
            {recentProjectOptions.length > 0 && (
              <div className="recent-projects">
                <span className="recent-projects-label">Recent folders</span>
                <div className="recent-projects-list">
                  {recentProjectOptions.map((option) => (
                    <button
                      key={option.value}
                      className="filter-chip recent-project-chip"
                      type="button"
                      title={option.value}
                      onClick={() => handleRecentProjectSelect(option.value)}
                    >
                      <span className="filter-chip-label">{option.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
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
                <span className="hint-icon" data-tooltip="Max runs executing in parallel. In Ranked mode this is one shared pool for candidate and reviewer runs." aria-label="Concurrency help">
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
                type="number"
                value={concurrency}
                required
                aria-describedby="concurrencyHint"
                onChange={(e) => setConcurrency(e.target.value)}
                onBlur={(e) => clampConcurrencyInput(e.target.value)}
              />
              <span className="form-hint" id="concurrencyHint">{concurrencyHint}</span>
            </div>
          </div>

          {/* Prompt / Task Prompt */}
          <workflow.FormFields
            prompt={prompt} setPrompt={setPrompt}
            taskPrompt={taskPrompt} setTaskPrompt={setTaskPrompt}
            reviewPrompt={reviewPrompt} setReviewPrompt={setReviewPrompt}
            reviewCount={reviewCount} setReviewCount={handleReviewCountChange}
          />

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
                setWorktreeRoot(c?.defaults?.worktreeRoot ?? "");
                setRunCount(String(c?.defaults?.runCount ?? 10));
                setConcurrency(String(c?.defaults?.runCount ?? 10));
                setPrompt("");
                setTaskPrompt("");
                setReviewPrompt(getDefaultReviewPrompt("repeated"));
                setReviewCount("3");
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

      {isOpen ? <FolderBrowser title={browserTitle} onSelect={handleBrowserSelect} /> : null}
    </>
  );
}
