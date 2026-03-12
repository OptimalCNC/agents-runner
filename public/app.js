/* ─── State ─── */
const state = {
  config: null,
  mode: "repeated",
  runs: [],
  runDetails: new Map(),
  selectedRunId: null,
  selectedAgentId: null,
  activeTab: "overview",
  browserTarget: null,
  browserPath: null,
  projectInspect: null,
  projectFilters: [],
  eventSource: null,
  autoWorktreeRoot: null,
  drawerOpen: false,
  inspectDebounceTimer: null,
};

/* ─── DOM References ─── */
const $ = (sel) => document.querySelector(sel);
const el = {
  connectionDot: $("#connectionDot"),
  connectionText: $("#connectionText"),
  runtimeBadge: $("#runtimeBadge"),
  runtimeText: $("#runtimeText"),
  newRunButton: $("#newRunButton"),
  drawerOverlay: $("#drawerOverlay"),
  drawer: $("#newRunDrawer"),
  closeDrawerButton: $("#closeDrawerButton"),
  runForm: $("#runForm"),
  projectPath: $("#projectPath"),
  worktreeRoot: $("#worktreeRoot"),
  runCount: $("#runCount"),
  concurrency: $("#concurrency"),
  prompt: $("#prompt"),
  promptGroup: $("#promptGroup"),
  taskPrompt: $("#taskPrompt"),
  taskPromptGroup: $("#taskPromptGroup"),
  submitButton: $("#submitButton"),
  resetFormButton: $("#resetFormButton"),
  inspectProjectButton: $("#inspectProjectButton"),
  projectInspectStatus: $("#projectInspectStatus"),
  projectInspectBox: $("#projectInspectBox"),
  inspectRepoRoot: $("#inspectRepoRoot"),
  inspectBranch: $("#inspectBranch"),
  inspectHead: $("#inspectHead"),
  projectFilters: $("#projectFilters"),
  runsList: $("#runsList"),
  runCountBadge: $("#runCountBadge"),
  mainContent: $("#mainContent"),
  browserDialog: $("#browserDialog"),
  browserTitle: $("#browserTitle"),
  browserCurrentPath: $("#browserCurrentPath"),
  browserList: $("#browserList"),
  browserUpButton: $("#browserUpButton"),
  browserSelectButton: $("#browserSelectButton"),
  browseProjectButton: $("#browseProjectButton"),
  browseWorktreeButton: $("#browseWorktreeButton"),
  toastContainer: $("#toastContainer"),
  segments: Array.from(document.querySelectorAll(".seg-btn")),
};

/* ─── Icons (inline SVG) ─── */
const icons = {
  check: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
  x: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
  clock: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
  folder: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`,
  git: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><line x1="6" y1="9" x2="6" y2="21"/></svg>`,
  play: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>`,
  refresh: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>`,
};

/* ─── Helpers ─── */
function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Request failed with ${response.status}`);
  return payload;
}

function formatDate(value) {
  if (!value) return "\u2014";
  const d = new Date(value);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatRelative(value) {
  if (!value) return "";
  const seconds = Math.floor((Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function formatStatus(value) {
  return (value ?? "").replaceAll("-", " ");
}

function normalizeMode(value) {
  return value === "generated" || value === "task-generator" ? "generated" : "repeated";
}

function formatModeLabel(value) {
  const mode = normalizeMode(value);
  return mode.charAt(0).toUpperCase() + mode.slice(1);
}

function deriveParentPath(targetPath) {
  const source = String(targetPath ?? "").trim();
  if (!source) return "";
  const normalized = source.replace(/[\\/]+$/, "");
  if (!normalized) return source;
  const slashIndex = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  if (slashIndex < 0) return "";
  if (slashIndex === 0) return normalized.slice(0, 1);
  if (/^[A-Za-z]:$/.test(normalized.slice(0, slashIndex))) return normalized.slice(0, slashIndex + 1);
  return normalized.slice(0, slashIndex);
}

function getPathLeaf(targetPath) {
  const source = String(targetPath ?? "").trim().replace(/[\\/]+$/, "");
  if (!source) return "";
  const segments = source.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] || source;
}

function getProjectPath(run) {
  return run?.config?.projectPath || "";
}

function getProjectFilterOptions() {
  const projectPaths = Array.from(new Set(state.runs.map(getProjectPath).filter(Boolean)))
    .sort((left, right) => {
      const byLeaf = getPathLeaf(left).localeCompare(getPathLeaf(right));
      return byLeaf || left.localeCompare(right);
    });

  const leafCounts = new Map();
  for (const projectPath of projectPaths) {
    const leaf = getPathLeaf(projectPath) || projectPath;
    leafCounts.set(leaf, (leafCounts.get(leaf) || 0) + 1);
  }

  return projectPaths.map((projectPath) => {
    const leaf = getPathLeaf(projectPath) || projectPath;
    return {
      value: projectPath,
      label: leafCounts.get(leaf) > 1 ? projectPath : leaf,
    };
  });
}

function normalizeProjectFilters() {
  const options = getProjectFilterOptions();
  const optionValues = new Set(options.map((option) => option.value));
  state.projectFilters = Array.from(new Set(state.projectFilters))
    .filter((value) => optionValues.has(value));
  return options;
}

function getVisibleRuns() {
  if (state.projectFilters.length === 0) {
    return state.runs;
  }

  const activeFilters = new Set(state.projectFilters);
  return state.runs.filter((run) => activeFilters.has(getProjectPath(run)));
}

/* ─── Toast System ─── */
function showToast(type, title, message) {
  const iconMap = {
    success: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`,
    error: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`,
    info: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`,
  };

  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <div class="toast-icon">${iconMap[type] || iconMap.info}</div>
    <div class="toast-body">
      <div class="toast-title">${escapeHtml(title)}</div>
      ${message ? `<div class="toast-message">${escapeHtml(message)}</div>` : ""}
    </div>
  `;

  el.toastContainer.appendChild(toast);

  const timer = setTimeout(() => {
    toast.classList.add("is-leaving");
    toast.addEventListener("animationend", () => toast.remove());
  }, 4000);

  toast.addEventListener("click", () => {
    clearTimeout(timer);
    toast.classList.add("is-leaving");
    toast.addEventListener("animationend", () => toast.remove());
  });
}

/* ─── Drawer ─── */
function openDrawer() {
  state.drawerOpen = true;
  el.drawer.classList.add("is-open");
  el.drawerOverlay.classList.add("is-open");
  document.body.style.overflow = "hidden";
}

function closeDrawer() {
  state.drawerOpen = false;
  el.drawer.classList.remove("is-open");
  el.drawerOverlay.classList.remove("is-open");
  document.body.style.overflow = "";
}

/* ─── Mode ─── */
function setMode(mode) {
  state.mode = normalizeMode(mode);
  for (const seg of el.segments) {
    seg.classList.toggle("is-active", seg.dataset.mode === state.mode);
  }
  const isGenerated = state.mode === "generated";
  el.taskPromptGroup.hidden = !isGenerated;
  el.promptGroup.hidden = isGenerated;
  el.prompt.required = !isGenerated;
  el.taskPrompt.required = isGenerated;
  updateSubmitButtonState();
}

/* ─── State Helpers ─── */
function updateSuggestedWorktreeRoot(nextRoot) {
  const suggestedRoot = String(nextRoot ?? "").trim();
  const currentRoot = el.worktreeRoot.value.trim();
  const shouldReplace = !currentRoot || currentRoot === state.autoWorktreeRoot;
  state.autoWorktreeRoot = suggestedRoot || null;
  if (shouldReplace) el.worktreeRoot.value = suggestedRoot;
}

function syncDefaultWorktreeRoot(projectPath) {
  updateSuggestedWorktreeRoot(deriveParentPath(projectPath));
}

function syncConcurrencyField() {
  const runCount = Number(el.runCount.value || "1");
  el.concurrency.max = String(runCount);
  if (Number(el.concurrency.value) > runCount) el.concurrency.value = String(runCount);
}

function sortRuns() {
  state.runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function upsertRunSummary(summary) {
  const idx = state.runs.findIndex((r) => r.id === summary.id);
  if (idx >= 0) state.runs[idx] = summary;
  else state.runs.push(summary);
  sortRuns();
}

function getSelectedRun() {
  return state.selectedRunId ? state.runDetails.get(state.selectedRunId) || null : null;
}

async function syncSelectedRun() {
  normalizeProjectFilters();
  const visibleRuns = getVisibleRuns();
  const selectedRunIsVisible = visibleRuns.some((run) => run.id === state.selectedRunId);

  if (!selectedRunIsVisible) {
    state.selectedRunId = visibleRuns[0]?.id || null;
    state.selectedAgentId = null;
    state.activeTab = "overview";
  }

  renderRuns();

  if (!state.selectedRunId) {
    renderRunDetail();
    return;
  }

  if (!state.runDetails.has(state.selectedRunId)) {
    await loadRunDetail(state.selectedRunId);
    return;
  }

  renderRunDetail();
}

async function removeRunFromState(runId) {
  state.runs = state.runs.filter((run) => run.id !== runId);
  state.runDetails.delete(runId);

  if (state.selectedRunId === runId) {
    state.selectedRunId = null;
    state.selectedAgentId = null;
    state.activeTab = "overview";
  }

  await syncSelectedRun();
}

/* ─── Status Pill ─── */
function statusPill(status) {
  const spinner = status === "running" ? `<span class="spinner"></span>` : "";
  return `<span class="pill pill-${escapeHtml(status)}">${spinner}${escapeHtml(formatStatus(status))}</span>`;
}

/* ─── Render: Runtime ─── */
function renderRuntime() {
  if (!state.config) {
    el.runtimeText.textContent = "Checking\u2026";
    return;
  }
  const env = state.config.codexEnvironment;
  if (env.hasOpenAIApiKey) {
    el.runtimeText.textContent = "API key detected";
    el.runtimeBadge.title = "OPENAI_API_KEY or CODEX_API_KEY is set";
  } else if (env.hasCodexProfile) {
    el.runtimeText.textContent = "Codex auth";
    el.runtimeBadge.title = "Using ~/.codex/auth.json";
  } else {
    el.runtimeText.textContent = "No auth";
    el.runtimeBadge.title = "No API key or Codex auth profile found";
  }
}

/* ─── Render: Project Inspect ─── */
function renderProjectInspect() {
  if (!state.projectInspect) {
    el.projectInspectBox.hidden = true;
    return;
  }
  el.projectInspectBox.hidden = false;
  el.inspectRepoRoot.textContent = state.projectInspect.repoRoot;
  el.inspectBranch.textContent = state.projectInspect.branchName || "(detached HEAD)";
  el.inspectHead.textContent = state.projectInspect.headSha;
}

/* ─── Render: Sidebar Run Cards ─── */
function summarizeProgress(run) {
  const c = run.completedAgents ?? 0;
  const f = run.failedAgents ?? 0;
  const k = run.cancelledAgents ?? 0;
  const parts = [];
  if (c) parts.push(`${c} done`);
  if (f) parts.push(`${f} failed`);
  if (k) parts.push(`${k} cancelled`);
  return parts.join(", ") || "Waiting\u2026";
}

function createRunCard(summary) {
  const totalDone = summary.completedAgents + summary.failedAgents + summary.cancelledAgents;
  const progress = summary.totalAgents ? Math.round((totalDone / summary.totalAgents) * 100) : 0;
  const selected = summary.id === state.selectedRunId ? " is-selected" : "";
  const hasFail = summary.failedAgents > 0 ? " has-failures" : "";
  const projectPath = summary.config?.projectPath || "";
  const projectFolder = getPathLeaf(projectPath);

  return `
    <div class="run-card${selected}" data-run-id="${escapeHtml(summary.id)}">
      <div class="run-card-top">
        <div class="run-card-info">
          <div class="run-card-title">${escapeHtml(summary.title)}</div>
          <div class="run-card-meta">${escapeHtml(formatModeLabel(summary.mode))} \u00b7 ${escapeHtml(formatRelative(summary.createdAt))}</div>
          ${projectFolder
            ? `<div class="run-card-project" title="${escapeHtml(projectPath)}">${icons.folder}<span>${escapeHtml(projectFolder)}</span></div>`
            : ""}
        </div>
        <div class="run-card-actions">
          ${statusPill(summary.status)}
          <button
            class="btn-icon run-card-delete"
            type="button"
            title="Remove run"
            aria-label="Remove run"
            data-action="delete-run"
            data-run-id="${escapeHtml(summary.id)}"
          >
            ${icons.x}
          </button>
        </div>
      </div>
      <div class="run-card-progress">
        <div class="progress-bar"><div class="progress-bar-fill${hasFail}" style="width:${progress}%"></div></div>
        <div class="progress-label">${escapeHtml(summarizeProgress(summary))} (${totalDone}/${summary.totalAgents})</div>
      </div>
    </div>
  `;
}

function renderProjectFilter() {
  const options = normalizeProjectFilters();

  if (options.length === 0) {
    el.projectFilters.innerHTML = `<div class="filter-chip-empty">No projects yet.</div>`;
    return;
  }

  const activeFilters = new Set(state.projectFilters);
  el.projectFilters.innerHTML = options.map((option) => `
    <button
      class="filter-chip${activeFilters.has(option.value) ? " is-active" : ""}"
      type="button"
      data-project-filter="${escapeHtml(option.value)}"
      title="${escapeHtml(option.value)}"
      aria-pressed="${activeFilters.has(option.value) ? "true" : "false"}"
    >
      <span class="filter-chip-label">${escapeHtml(option.label)}</span>
    </button>
  `).join("");
}

function renderRuns() {
  renderProjectFilter();

  const visibleRuns = getVisibleRuns();
  el.runCountBadge.textContent = state.projectFilters.length > 0
    ? `${visibleRuns.length}/${state.runs.length}`
    : String(state.runs.length);

  if (visibleRuns.length === 0) {
    el.runsList.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 8v8M8 12h8"/></svg>
        </div>
        <p class="empty-title">${escapeHtml(state.projectFilters.length > 0 ? "No matching runs" : "No runs yet")}</p>
        <p class="empty-desc">${escapeHtml(state.projectFilters.length > 0 ? "Adjust the project filters." : "Click \"New Run\" to get started")}</p>
      </div>
    `;
    return;
  }

  el.runsList.innerHTML = visibleRuns.map(createRunCard).join("");
}

/* ─── Render: Run Detail ─── */
function renderTasksSection(generation) {
  if (!generation) return "";

  const tasksMarkup = generation.tasks?.length
    ? generation.tasks.map((t, i) => `
        <div class="task-item">
          <div class="task-item-title">${escapeHtml(`${i + 1}. ${t.title}`)}</div>
          <div class="task-item-prompt">${escapeHtml(t.prompt)}</div>
        </div>
      `).join("")
    : `<div class="text-muted text-sm">No tasks generated yet.</div>`;

  return `
    <div class="tasks-section">
      <div class="section-header">
        <div class="section-title">${icons.play} Generated Tasks ${statusPill(generation.status)}</div>
      </div>
      <div class="task-list">${tasksMarkup}</div>
    </div>
  `;
}

function renderAgentCards(run) {
  if (!run.agents.length) {
    return `
      <div class="empty-state">
        <div class="empty-icon">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
        </div>
        <p class="empty-title">Waiting for agents</p>
        <p class="empty-desc">Work items appear once the run creates them.</p>
      </div>
    `;
  }

  return `
    <div class="agents-grid">
      ${run.agents.map((agent) => {
        const sel = agent.id === state.selectedAgentId ? " is-selected" : "";
        return `
          <div class="agent-card${sel}" data-agent-id="${escapeHtml(agent.id)}">
            <div class="agent-card-top">
              <div class="agent-card-title">${escapeHtml(agent.title)}</div>
              ${statusPill(agent.status)}
            </div>
            <div class="agent-card-meta">Agent ${agent.index + 1}</div>
            <div class="tag-row">
              ${agent.threadId ? `<span class="tag">Thread ${escapeHtml(agent.threadId)}</span>` : ""}
              ${agent.review?.statusShort ? `<span class="tag">${escapeHtml(agent.review.statusShort.split("\n")[0])}</span>` : ""}
            </div>
          </div>
        `;
      }).join("")}
    </div>
  `;
}

function renderAgentDetailTabs(agent) {
  if (!agent) {
    return `
      <div class="agent-detail">
        <div class="empty-state">
          <div class="empty-icon">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
          </div>
          <p class="empty-title">No agent selected</p>
          <p class="empty-desc">Select an agent card above to inspect details.</p>
        </div>
      </div>
    `;
  }

  const activeTab = state.activeTab === "items" ? "history" : (state.activeTab || "overview");
  const directory = agent.workingDirectory || agent.worktreePath || "Pending";

  const tabs = [
    { key: "overview", label: "Overview" },
    { key: "response", label: "Response" },
    { key: "review", label: "Review" },
    { key: "history", label: `History (${agent.items.length})` },
    { key: "logs", label: `Logs (${agent.logs.length})` },
  ];

  const overviewPanel = `
    <div class="tab-panel${activeTab === "overview" ? " is-active" : ""}" data-tab="overview">
      <div class="meta-group">
        <div class="meta-row"><span class="meta-row-label">Status</span>${statusPill(agent.status)}</div>
        <div class="meta-row"><span class="meta-row-label">Directory</span><span class="meta-row-value mono">${escapeHtml(directory)}</span></div>
        <div class="meta-row"><span class="meta-row-label">Started</span><span class="meta-row-value">${escapeHtml(formatDate(agent.startedAt))}</span></div>
        <div class="meta-row"><span class="meta-row-label">Completed</span><span class="meta-row-value">${escapeHtml(formatDate(agent.completedAt))}</span></div>
        ${agent.usage ? `<div class="meta-row"><span class="meta-row-label">Tokens</span><span class="meta-row-value">${escapeHtml(`${agent.usage.input_tokens} in / ${agent.usage.output_tokens} out / ${agent.usage.total_tokens} total`)}</span></div>` : ""}
        ${agent.error ? `<div class="meta-row"><span class="meta-row-label">Error</span><span class="meta-row-value" style="color:var(--danger)">${escapeHtml(agent.error)}</span></div>` : ""}
      </div>
      <div class="review-section">
        <div class="review-section-title">Prompt</div>
        <pre class="code-block">${escapeHtml(agent.prompt)}</pre>
      </div>
    </div>
  `;

  const responsePanel = `
    <div class="tab-panel${activeTab === "response" ? " is-active" : ""}" data-tab="response">
      <pre class="response-block">${escapeHtml(agent.finalResponse || "No final response captured yet.")}</pre>
    </div>
  `;

  const review = agent.review;
  const reviewContent = review ? `
    <div class="review-section">
      <div class="review-section-title">Git Status</div>
      <pre class="code-block">${escapeHtml(review.statusShort || "No tracked changes.")}</pre>
    </div>
    <div class="review-section">
      <div class="review-section-title">Diff Stat</div>
      <pre class="code-block">${escapeHtml(review.diffStat || "No diff stat available.")}</pre>
    </div>
    <div class="review-section">
      <div class="review-section-title">Tracked Diff</div>
      <pre class="code-block">${escapeHtml(review.trackedDiff || "No tracked diff.")}</pre>
    </div>
    ${(review.untrackedFiles || []).map((f) => `
      <div class="review-section">
        <div class="review-section-title">Untracked: ${escapeHtml(f.path)}</div>
        <pre class="code-block">${escapeHtml(f.preview)}</pre>
      </div>
    `).join("")}
  ` : `<div class="text-muted text-sm">No review data yet. Click "Refresh Review" after the worktree is created.</div>`;

  const reviewPanel = `
    <div class="tab-panel${activeTab === "review" ? " is-active" : ""}" data-tab="review">
      <div class="tab-panel-toolbar">
        <button class="btn btn-ghost btn-sm" type="button" data-action="refresh-review">${icons.refresh} Refresh Review</button>
      </div>
      ${reviewContent}
    </div>
  `;

  const historyPanel = `
    <div class="tab-panel${activeTab === "history" ? " is-active" : ""}" data-tab="history">
      ${agent.items.length ? agent.items.map((item) => `
        <div class="review-section">
          <div class="review-section-title">${escapeHtml(item.type)}</div>
          <pre class="code-block">${escapeHtml(JSON.stringify(item, null, 2))}</pre>
        </div>
      `).join("") : `<div class="text-muted text-sm">No streamed history recorded yet.</div>`}
    </div>
  `;

  const logsPanel = `
    <div class="tab-panel${activeTab === "logs" ? " is-active" : ""}" data-tab="logs">
      ${agent.logs.length ? agent.logs.map((entry) => `
        <div class="log-entry">
          <div class="log-entry-header">
            <span class="log-level log-level-${escapeHtml(entry.level)}">${escapeHtml(entry.level.toUpperCase())}</span>
            <span class="log-time">${escapeHtml(formatDate(entry.at))}</span>
          </div>
          <div class="log-msg">${escapeHtml(entry.message)}</div>
        </div>
      `).join("") : `<div class="text-muted text-sm">No log entries yet.</div>`}
    </div>
  `;

  return `
    <div class="agent-detail">
      <div class="agent-detail-header">
        <div class="agent-detail-title">${escapeHtml(agent.title)}</div>
        <div class="agent-detail-header-actions">
          ${statusPill(agent.status)}
        </div>
      </div>
      <div class="tab-bar">
        ${tabs.map((t) => `
          <button class="tab-btn${activeTab === t.key ? " is-active" : ""}" data-tab-key="${t.key}" type="button">${t.label}</button>
        `).join("")}
      </div>
      ${overviewPanel}
      ${responsePanel}
      ${reviewPanel}
      ${historyPanel}
      ${logsPanel}
    </div>
  `;
}

function renderRunDetail() {
  const run = getSelectedRun();
  if (!run) {
    el.mainContent.innerHTML = `
      <div class="empty-state main-empty">
        <div class="empty-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
        </div>
        <p class="empty-title">No run selected</p>
        <p class="empty-desc">Launch a run or select one from the sidebar to inspect agent output.</p>
      </div>
    `;
    return;
  }

  if (!run.agents.find((a) => a.id === state.selectedAgentId)) {
    state.selectedAgentId = run.agents[0]?.id || null;
  }

  const selectedAgent = run.agents.find((a) => a.id === state.selectedAgentId) || null;
  const canCancel = run.status === "running" || run.status === "queued";
  const baseRef = run.config.baseRef || run.projectContext?.branchName || run.projectContext?.headSha || "Current HEAD";

  el.mainContent.innerHTML = `
    <div class="run-detail">
      <div class="run-detail-header">
        <div class="run-detail-title-area">
          <h2>${escapeHtml(run.title)}</h2>
          <div class="run-detail-meta">
            <span class="meta-item">${icons.clock} Created ${escapeHtml(formatRelative(run.createdAt))}</span>
            <span class="meta-item">${icons.folder} ${escapeHtml(run.config.projectPath)}</span>
          </div>
        </div>
        <div class="run-detail-actions">
          ${statusPill(run.status)}
          ${canCancel ? `<button class="btn btn-danger btn-sm" type="button" data-action="cancel-run">${icons.x} Cancel</button>` : ""}
        </div>
      </div>

      <div class="info-cards">
        <div class="info-card">
          <div class="info-card-label">Mode</div>
          <div class="info-card-value">${escapeHtml(formatModeLabel(run.mode))}</div>
        </div>
        <div class="info-card">
          <div class="info-card-label">Agents</div>
          <div class="info-card-value">${run.agents.length} / ${escapeHtml(run.config.runCount)}</div>
        </div>
        <div class="info-card">
          <div class="info-card-label">Concurrency</div>
          <div class="info-card-value">${escapeHtml(run.config.concurrency)}</div>
        </div>
        <div class="info-card">
          <div class="info-card-label">Base Ref</div>
          <div class="info-card-value">${escapeHtml(baseRef)}</div>
        </div>
        <div class="info-card">
          <div class="info-card-label">Started</div>
          <div class="info-card-value">${escapeHtml(formatDate(run.startedAt))}</div>
        </div>
        <div class="info-card">
          <div class="info-card-label">Completed</div>
          <div class="info-card-value">${escapeHtml(formatDate(run.completedAt))}</div>
        </div>
        <div class="info-card">
          <div class="info-card-label">Sandbox</div>
          <div class="info-card-value">${escapeHtml(run.config.sandboxMode)}</div>
        </div>
      </div>

      ${run.error ? `<div style="padding:10px 14px;background:var(--danger-soft);border:1px solid rgba(239,68,68,0.25);border-radius:var(--radius-sm);color:var(--danger);font-size:13px;margin-bottom:24px;">${escapeHtml(run.error)}</div>` : ""}

      ${renderTasksSection(run.generation)}

      <div class="agents-section">
        <div class="section-header">
          <div class="section-title">Agents</div>
          <span class="text-muted text-sm">${escapeHtml(summarizeProgress({
            completedAgents: run.agents.filter((a) => a.status === "completed").length,
            failedAgents: run.agents.filter((a) => a.status === "failed").length,
            cancelledAgents: run.agents.filter((a) => a.status === "cancelled").length,
          }))}</span>
        </div>
        ${renderAgentCards(run)}
      </div>

      ${renderAgentDetailTabs(selectedAgent)}
    </div>
  `;
}

/* ─── Form validation ─── */
function updateSubmitButtonState() {
  const projectPath = el.projectPath.value.trim();
  const hasValidInspect = !!state.projectInspect;
  const hasPrompt = el.prompt.value.trim().length > 0;
  const hasTaskPrompt = el.taskPrompt.value.trim().length > 0;

  const canSubmit =
    projectPath.length > 0 &&
    hasValidInspect &&
    (state.mode === "repeated" ? hasPrompt : hasTaskPrompt);

  el.submitButton.disabled = !canSubmit;
}

function scheduleAutoInspect() {
  if (state.inspectDebounceTimer) clearTimeout(state.inspectDebounceTimer);
  state.inspectDebounceTimer = setTimeout(() => {
    state.inspectDebounceTimer = null;
    const path = el.projectPath.value.trim();
    if (path) void inspectProject();
    else {
      state.projectInspect = null;
      el.projectInspectBox.hidden = true;
      el.projectInspectStatus.textContent = "";
      updateSubmitButtonState();
    }
  }, 600);
}

/* ─── Form ─── */
function resetForm() {
  el.runForm.reset();
  el.runCount.value = state.config?.defaults.runCount ?? 10;
  el.concurrency.value = state.config?.defaults.runCount ?? 10;
  $("#sandboxMode").value = state.config?.defaults.sandboxMode ?? "workspace-write";
  $("#approvalPolicy").value = state.config?.defaults.approvalPolicy ?? "never";
  el.taskPrompt.value = "";
  el.prompt.value = "";
  state.projectInspect = null;
  state.autoWorktreeRoot = null;
  el.projectInspectStatus.textContent = "";
  setMode("repeated");
  syncConcurrencyField();
  renderProjectInspect();
  updateSubmitButtonState();
}

/* ─── Data Loading ─── */
async function loadConfig() {
  state.config = await fetchJson("/api/config");
  renderRuntime();
  resetForm();
}

async function loadRuns() {
  const payload = await fetchJson("/api/runs");
  state.runs = payload.runs;
  sortRuns();
  await syncSelectedRun();
}

async function loadRunDetail(runId) {
  try {
    const payload = await fetchJson(`/api/runs/${encodeURIComponent(runId)}`);
    state.runDetails.set(runId, payload.run);
    upsertRunSummary({
      id: payload.run.id,
      mode: normalizeMode(payload.run.mode ?? payload.run.workflowType),
      title: payload.run.title,
      status: payload.run.status,
      createdAt: payload.run.createdAt,
      startedAt: payload.run.startedAt,
      completedAt: payload.run.completedAt,
      cancelRequested: payload.run.cancelRequested,
      totalAgents: payload.run.agents.length,
      completedAgents: payload.run.agents.filter((a) => a.status === "completed").length,
      failedAgents: payload.run.agents.filter((a) => a.status === "failed").length,
      cancelledAgents: payload.run.agents.filter((a) => a.status === "cancelled").length,
      runningAgents: payload.run.agents.filter((a) => a.status === "running").length,
      queuedAgents: payload.run.agents.filter((a) => a.status === "queued").length,
      config: payload.run.config,
      generation: payload.run.generation,
    });
    renderRuns();
    renderRunDetail();
  } catch (error) {
    if (error.message === "Run not found.") {
      await removeRunFromState(runId);
      return;
    }
    throw error;
  }
}

/* ─── SSE ─── */
function connectEvents() {
  state.eventSource?.close();
  state.eventSource = new EventSource("/events");
  el.connectionText.textContent = "Connecting\u2026";
  el.connectionDot.className = "conn-dot";

  state.eventSource.addEventListener("open", () => {
    el.connectionText.textContent = "Connected";
    el.connectionDot.className = "conn-dot is-connected";
  });

  state.eventSource.addEventListener("runs.snapshot", async (event) => {
    const payload = JSON.parse(event.data);
    state.runs = payload.runs;
    sortRuns();
    await syncSelectedRun();
  });

  state.eventSource.addEventListener("run.updated", async (event) => {
    const payload = JSON.parse(event.data);
    upsertRunSummary(payload.summary);
    state.runDetails.set(payload.run.id, payload.run);
    if (!state.selectedRunId && getVisibleRuns()[0]) {
      state.selectedRunId = getVisibleRuns()[0].id;
    }
    await syncSelectedRun();
  });

  state.eventSource.addEventListener("run.deleted", async (event) => {
    const payload = JSON.parse(event.data);
    await removeRunFromState(payload.runId);
  });

  state.eventSource.addEventListener("error", () => {
    el.connectionText.textContent = "Disconnected";
    el.connectionDot.className = "conn-dot is-error";
  });
}

/* ─── Actions ─── */
async function inspectProject() {
  const projectPath = el.projectPath.value.trim();
  if (!projectPath) {
    el.projectInspectStatus.textContent = "Project path required.";
    state.projectInspect = null;
    updateSubmitButtonState();
    return;
  }
  el.projectInspectStatus.textContent = "Inspecting\u2026";
  try {
    const payload = await fetchJson("/api/project/inspect", {
      method: "POST",
      body: JSON.stringify({ path: projectPath }),
    });
    state.projectInspect = payload.projectContext;
    updateSuggestedWorktreeRoot(deriveParentPath(payload.projectContext.projectPath));
    el.projectInspectStatus.textContent = "Git project ready.";
    renderProjectInspect();
  } catch (error) {
    state.projectInspect = null;
    el.projectInspectStatus.textContent = error.message;
    renderProjectInspect();
  }
  updateSubmitButtonState();
}

async function submitRun(event) {
  event.preventDefault();
  el.submitButton.disabled = true;
  el.submitButton.textContent = "Starting\u2026";

  try {
    const payload = {
      mode: state.mode,
      projectPath: el.projectPath.value.trim(),
      worktreeRoot: el.worktreeRoot.value.trim(),
      runCount: Number(el.runCount.value),
      concurrency: Number(el.concurrency.value),
      prompt: el.prompt.value.trim(),
      taskPrompt: el.taskPrompt.value.trim(),
      baseRef: $("#baseRef").value.trim(),
      model: $("#model").value.trim(),
      reasoningEffort: $("#reasoningEffort").value,
      sandboxMode: $("#sandboxMode").value,
      approvalPolicy: $("#approvalPolicy").value,
      networkAccessEnabled: $("#networkAccessEnabled").checked,
      webSearchMode: $("#webSearchMode").checked ? "live" : "disabled",
    };

    const response = await fetchJson("/api/runs", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    state.selectedRunId = response.run.id;
    state.selectedAgentId = null;
    if (state.projectFilters.length > 0 && !state.projectFilters.includes(response.run.config.projectPath)) {
      state.projectFilters = [...state.projectFilters, response.run.config.projectPath];
    }
    state.runDetails.set(response.run.id, response.run);
    await loadRunDetail(response.run.id);
    closeDrawer();
    showToast("success", "Run started", `${response.run.title} is now running.`);
  } catch (error) {
    showToast("error", "Failed to start run", error.message);
  } finally {
    el.submitButton.disabled = false;
    el.submitButton.innerHTML = `${icons.play} Start Run`;
  }
}

async function cancelSelectedRun() {
  if (!state.selectedRunId) return;
  try {
    await fetchJson(`/api/runs/${encodeURIComponent(state.selectedRunId)}/cancel`, { method: "POST" });
    showToast("info", "Cancel requested", "The run will stop after current agents finish.");
  } catch (error) {
    showToast("error", "Cancel failed", error.message);
  }
}

async function deleteRunById(runId) {
  const run = state.runs.find((entry) => entry.id === runId);
  if (!run) {
    return;
  }

  const confirmed = window.confirm(
    run.status === "running" || run.status === "queued"
      ? `Remove "${run.title}"? Active agents will be cancelled.`
      : `Remove "${run.title}"?`,
  );

  if (!confirmed) {
    return;
  }

  try {
    await fetchJson(`/api/runs/${encodeURIComponent(runId)}`, { method: "DELETE" });
    await removeRunFromState(runId);
    showToast("success", "Run removed", run.title);
  } catch (error) {
    showToast("error", "Remove failed", error.message);
  }
}

async function refreshAgentReview() {
  const run = getSelectedRun();
  if (!run || !state.selectedAgentId) return;
  const agent = run.agents.find((a) => a.id === state.selectedAgentId);
  if (!agent) return;
  try {
    const payload = await fetchJson(
      `/api/runs/${encodeURIComponent(run.id)}/agents/${encodeURIComponent(agent.id)}/review`,
    );
    const mutableRun = state.runDetails.get(run.id);
    const mutableAgent = mutableRun?.agents.find((a) => a.id === agent.id);
    if (mutableAgent) mutableAgent.review = payload.review;
    renderRunDetail();
    showToast("success", "Review refreshed", "Git review data updated.");
  } catch (error) {
    showToast("error", "Review failed", error.message);
  }
}

/* ─── Folder Browser ─── */
async function openBrowser(target, title) {
  state.browserTarget = target;
  el.browserTitle.textContent = title;
  el.browserDialog.showModal();
  await browsePath(target.value.trim() || state.config?.homeDirectory || "");
}

async function browsePath(targetPath) {
  const payload = await fetchJson(`/api/fs?path=${encodeURIComponent(targetPath)}`);
  state.browserPath = payload.path;
  el.browserCurrentPath.textContent = payload.path;
  el.browserUpButton.disabled = !payload.parentPath;

  el.browserList.innerHTML = payload.directories.length
    ? payload.directories.map((entry) => `
        <button class="browser-entry" type="button" data-browser-path="${escapeHtml(entry.path)}">
          ${escapeHtml(entry.name)}
        </button>
      `).join("")
    : `<div class="empty-state"><p class="empty-title">No child folders</p></div>`;

  el.browserUpButton.dataset.parentPath = payload.parentPath || "";
}

/* ─── Event Binding ─── */
function bindEvents() {
  for (const seg of el.segments) {
    seg.addEventListener("click", () => setMode(seg.dataset.mode));
  }

  el.newRunButton.addEventListener("click", openDrawer);
  el.closeDrawerButton.addEventListener("click", closeDrawer);
  el.drawerOverlay.addEventListener("click", closeDrawer);

  el.runCount.addEventListener("input", syncConcurrencyField);

  el.projectPath.addEventListener("input", () => {
    state.projectInspect = null;
    el.projectInspectBox.hidden = true;
    el.projectInspectStatus.textContent = "";
    syncDefaultWorktreeRoot(el.projectPath.value);
    scheduleAutoInspect();
  });

  el.prompt.addEventListener("input", updateSubmitButtonState);
  el.taskPrompt.addEventListener("input", updateSubmitButtonState);

  el.runForm.addEventListener("submit", submitRun);
  el.resetFormButton.addEventListener("click", resetForm);
  el.inspectProjectButton.addEventListener("click", inspectProject);
  el.browseProjectButton.addEventListener("click", () => openBrowser(el.projectPath, "Choose Project Folder"));
  el.browseWorktreeButton.addEventListener("click", () => openBrowser(el.worktreeRoot, "Choose Worktree Root"));

  el.runsList.addEventListener("click", async (event) => {
    const deleteButton = event.target.closest('[data-action="delete-run"]');
    if (deleteButton) {
      await deleteRunById(deleteButton.dataset.runId);
      return;
    }

    const card = event.target.closest(".run-card[data-run-id]");
    if (!card) return;
    state.selectedRunId = card.dataset.runId;
    state.selectedAgentId = null;
    state.activeTab = "overview";
    await loadRunDetail(state.selectedRunId);
  });

  el.projectFilters.addEventListener("click", async (event) => {
    const filterChip = event.target.closest("[data-project-filter]");
    if (!filterChip) return;

    const projectPath = filterChip.dataset.projectFilter;
    if (!projectPath) return;

    if (state.projectFilters.includes(projectPath)) {
      state.projectFilters = state.projectFilters.filter((value) => value !== projectPath);
    } else {
      state.projectFilters = [...state.projectFilters, projectPath];
    }

    await syncSelectedRun();
  });

  el.mainContent.addEventListener("click", async (event) => {
    const agentCard = event.target.closest("[data-agent-id]");
    if (agentCard) {
      state.selectedAgentId = agentCard.dataset.agentId;
      state.activeTab = "overview";
      renderRunDetail();
      return;
    }

    const tabBtn = event.target.closest("[data-tab-key]");
    if (tabBtn) {
      state.activeTab = tabBtn.dataset.tabKey;
      el.mainContent.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("is-active", b.dataset.tabKey === state.activeTab));
      el.mainContent.querySelectorAll(".tab-panel").forEach((p) => p.classList.toggle("is-active", p.dataset.tab === state.activeTab));
      return;
    }

    const action = event.target.closest("[data-action]")?.dataset.action;
    if (!action) return;
    if (action === "cancel-run") await cancelSelectedRun();
    if (action === "refresh-review") await refreshAgentReview();
  });

  el.browserList.addEventListener("click", async (event) => {
    const entry = event.target.closest("[data-browser-path]");
    if (!entry) return;
    await browsePath(entry.dataset.browserPath);
  });

  el.browserUpButton.addEventListener("click", async () => {
    const parentPath = el.browserUpButton.dataset.parentPath;
    if (parentPath) await browsePath(parentPath);
  });

  el.browserSelectButton.addEventListener("click", async () => {
    if (state.browserTarget) {
      state.browserTarget.value = state.browserPath || "";
      if (state.browserTarget === el.projectPath) {
        state.projectInspect = null;
        el.projectInspectBox.hidden = true;
        el.projectInspectStatus.textContent = "";
        syncDefaultWorktreeRoot(state.browserPath || "");
        if (state.browserPath) void inspectProject();
      }
    }
    el.browserDialog.close();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.drawerOpen) closeDrawer();
  });
}

/* ─── Init ─── */
async function init() {
  bindEvents();
  await loadConfig();
  await loadRuns();
  connectEvents();
}

init().catch((error) => {
  console.error(error);
  showToast("error", "Initialization failed", error.message);
});
