# Agents Runner — Frontend

Preact + TypeScript + Vite single-page application for managing Codex SDK batch runs across git worktrees.

---

## Tech Stack

| Tool | Version | Reason |
|------|---------|--------|
| **Preact** | ^10 | ~3KB React-compatible UI library; React hooks/JSX work without changes |
| **@preact/signals** | ^1 | Fine-grained reactive state; components re-render only when their signals change |
| **Vite** | ^6 | Sub-second HMR, first-class Preact support via `@preact/preset-vite` |
| **TypeScript** | ^5.7 | Strict mode; props validated at compile time |
| **marked** | ^15 | Markdown → HTML parsing for agent messages |
| **DOMPurify** | ^3 | Sanitizes parsed HTML before injection to prevent XSS |

> **Why Preact over React?** The bundle is ~10× smaller and the API is identical. Coding agents trained on React work seamlessly here. Besides, we are creating small apps for automating batch workflows, a large framework is not necessary.

> **Why signals over useState/useReducer?** The app receives frequent SSE-driven updates from the backend. Signals update only the components that read them; there is no top-down re-render cascade.

---

## Directory Structure

```
frontend/
├── index.html            # Minimal shell: <div id="app"> + Vite script tag
├── vite.config.ts        # Preact preset; dev proxy to :3000; build → ../public/
├── tsconfig.json         # ES2020, ESNext modules, jsx: react-jsx + jsxImportSource: preact
├── package.json
└── src/
    ├── main.tsx          # Bootstrap: load config+batches, connect SSE, render <App />
    ├── App.tsx           # Root layout: Navbar + Sidebar + BatchDetail + all dialogs
    ├── types.ts          # Frontend-only copy of domain types (no Node.js imports)
    ├── icons.tsx         # 23 SVG icon components (all exported as <FooIcon />)
    ├── state/
    │   ├── store.ts      # All signals + computed values + state helpers
    │   ├── api.ts        # Typed fetch wrappers for every backend endpoint
    │   ├── sse.ts        # EventSource with 5s auto-reconnect; writes to signals
    │   ├── codexAuth.ts  # Codex auth status signal + refresh logic
    │   └── modelCatalog.ts # Model catalog loading (lazy, triggered after auth)
    ├── utils/
    │   ├── format.ts     # Date, status, mode, reasoning-effort formatting
    │   ├── markdown.ts   # marked.parse + DOMPurify.sanitize wrapper
    │   └── paths.ts      # deriveParentPath, getPathLeaf, getProjectPath
    ├── workflows/        # Per-mode UI modules (mirrors backend src/lib/workflows/)
    │   ├── types.ts      # WorkflowUI interface + FormFieldsProps, RunsGridProps, RunCardExtras
    │   ├── shared.ts     # Shared helpers: normalizeScore, formatRunStatusLabel
    │   ├── registry.ts   # getWorkflowUI(mode) / getAllWorkflowUIs() registry
    │   ├── repeated.tsx  # Repeated mode: flat prompt, flat runs grid
    │   ├── generated.tsx # Generated mode: task-gen prompt, tasks section, flat grid
    │   └── ranked.tsx    # Ranked mode: reviewer glance, candidate grid, scoring
    ├── components/
    │   ├── Navbar.tsx
    │   ├── Sidebar.tsx
    │   ├── BatchCard.tsx
    │   ├── BatchDetail.tsx
    │   ├── RunCard.tsx
    │   ├── RunDetail.tsx
    │   ├── ProjectFilter.tsx
    │   ├── StatusPill.tsx
    │   ├── StreamItemView.tsx
    │   ├── Toast.tsx
    │   ├── ToastContainer.tsx
    │   └── tabs/
    │       ├── OverviewTab.tsx   # Run metadata + original prompt
    │       ├── ResponseTab.tsx   # Final agent response (markdown)
    │       ├── ReviewTab.tsx     # Git diff + untracked file previews
    │       ├── HistoryTab.tsx    # Streamed items timeline
    │       └── LogsTab.tsx       # Log entries table
    └── dialogs/
        ├── NewBatchDrawer.tsx    # Full batch-creation form (slide-in drawer)
        ├── ModelPicker.tsx       # Model combobox with live Codex catalog
        ├── FolderBrowser.tsx     # Directory picker dialog
        └── DeleteBatchDialog.tsx # Confirmation + worktree-removal preview
```

---

## State Management

All global state lives in `src/state/store.ts` as Preact signals. There is no context provider or prop-drilling for shared state.

### Signals (source of truth)

| Signal | Type | Purpose |
|--------|------|---------|
| `connectionStatus` | `"connecting" \| "connected" \| "disconnected"` | SSE link health |
| `config` | `AppConfig \| null` | Runtime config from backend |
| `batches` | `BatchSummary[]` | Sidebar list |
| `batchDetails` | `Map<string, Batch>` | Detail cache keyed by batch ID |
| `selectedBatchId` | `string \| null` | Currently open batch |
| `selectedRunId` | `string \| null` | Currently open run within batch |
| `activeTab` | `string` | Active tab in run detail view |
| `drawerOpen` | `boolean` | New-batch drawer visibility |
| `modelMenuOpen` | `boolean` | Model combobox open state |
| `projectFilters` | `string[]` | Active project-path filter chips |
| `projectInspect` | `ProjectContext \| null` | Inspected project in drawer |
| `browserState` | `BrowserState` | Directory browser navigation state |
| `browserDialogOpen` | `boolean` | Directory browser dialog visibility |
| `deleteDialog` | `DeleteDialogState` | Delete-confirmation dialog state |
| `modelCatalog` | `ModelCatalogState` | Codex model list + loading state |
| `toasts` | `Toast[]` | Notification stack |

### Computed signals

```ts
// Derived automatically; no manual updates needed
export const selectedBatch = computed(() => ...);
export const visibleBatches = computed(() => ...); // filters applied
```

### Mutation helpers (exported from store.ts)

`sortBatches`, `upsertBatchSummary`, `setBatchDetail`, `syncSelectedBatch`, `removeBatchFromState`, `addToast`, `removeToast`, `getProjectFilterOptions`, `normalizeProjectFilters` — always mutate signals through these helpers, not directly, to keep state consistent.

---

## Data Flow

```
User action
    │
    ▼
api.ts function (typed fetch → /api/*)
    │
    ▼
Signal update (store.ts helper)
    │
    ▼
Components that read that signal re-render

SSE server push
    │
    ▼
sse.ts event handler
    │
    ▼
Signal update (same helpers)
    │
    ▼
Affected components re-render
```

There are no manual render calls. Preact signals handle all reactivity automatically.

---

## Component Architecture

### Layout

```
App
├── Navbar          — logo, connection dot, runtime badge, "New Batch" button
├── Sidebar         — project filter chips + scrollable batch card list
│   ├── ProjectFilter
│   └── BatchCard   — status pill, progress bar, delete button
├── BatchDetail     — header, generated-tasks panel, run cards grid, selected run
│   ├── RunCard     — clickable card per run
│   └── RunDetail   — tabbed detail for selected run
│       ├── OverviewTab
│       ├── ResponseTab
│       ├── ReviewTab
│       ├── HistoryTab  ← uses StreamItemView
│       └── LogsTab
├── NewBatchDrawer  — slide-in form
│   ├── ModelPicker
│   └── FolderBrowser
├── DeleteBatchDialog
└── ToastContainer
    └── Toast
```

### StreamItemView

The history timeline renders eight item types via a single discriminated-union switch:

| Type | Icon | Notes |
|------|------|-------|
| `agent_message` | Bot | Markdown body via `renderMarkdown` |
| `command_execution` | Terminal | Exit code badge; stdout/stderr collapsible |
| `file_change` | File | Kind badge (add/delete/update) per file path |
| `reasoning` | Brain | Collapsed by default |
| `todo_list` | Checkbox | Completed items struck through |
| `mcp_tool_call` | Wrench | Args + result JSON; error state |
| `web_search` | Search | Query string |
| `error` | Alert | Error message |

---

## API Layer

All HTTP calls go through `src/state/api.ts`. Every function is typed end-to-end.

```ts
// Error handling: all non-2xx responses throw ApiError
export class ApiError extends Error {
  status: number;
  details?: unknown;
  constructor(message: string, status: number, details?: unknown) {}
}

// Representative calls
apiLoadConfig()                         // GET /api/config
apiLoadBatches()                        // GET /api/batches
apiLoadBatch(id)                        // GET /api/batches/:id
apiSubmitBatch(payload)                 // POST /api/batches
apiCancelBatch(id)                      // POST /api/batches/:id/cancel
apiDeleteBatch(id, removeWorktrees)     // DELETE /api/batches/:id
apiGetDeletePreview(id)                 // GET /api/batches/:id/delete-preview
apiGetRunReview(batchId, runId)         // GET /api/batches/:batchId/runs/:runId/review
apiInspectProject(path)                 // POST /api/project/inspect
apiBrowseFs(path)                       // GET /api/fs?path=...
apiLoadModels(refresh?)                 // GET /api/models[?refresh=true]
apiLoadCodexAuthStatus()                // GET /api/auth/status
```

---

## SSE Connection

`src/state/sse.ts` opens a single `/events` EventSource and handles:

| Event | Action |
|-------|--------|
| `batches.snapshot` | Replace `batches` signal with full list |
| `batch.updated` | `setBatchDetail` + `upsertBatchSummary` |
| `batch.deleted` | `removeBatchFromState` |
| `error` | Close + schedule reconnect in 5s |

On disconnect, the `connectionStatus` signal changes to `"disconnected"` and the Navbar shows a red dot. The connection is restored automatically.

---

## Types

`src/types.ts` is a **standalone copy** of the domain types with no Node.js or backend imports. When adding or changing backend types in `src/types.ts`, mirror the change here manually.

Key interfaces: `Batch`, `BatchSummary`, `Run`, `BatchConfig`, `StreamItem` (discriminated union of 8 subtypes), `RunReview`, `ProjectContext`, `AppConfig`.

---

## CSS / Design System

Styles live in `src/styles/index.css` (copied from the original `public/styles.css`). Everything is plain CSS — no Tailwind, no CSS Modules.

### Design tokens (CSS custom properties)

```
--bg-base:    #09090b        Dark base
--bg-surface: #0f0f12 …      Surface layers
--text-primary: #fafafa
--text-secondary: #a1a1aa
--accent: #6366f1            Indigo primary
--radius-*                   xs=6px … full=999px
--shadow-*                   sm … xl
```

### Layout constants

| Variable | Value |
|----------|-------|
| Navbar height | 56px |
| Sidebar width | 320px |
| Drawer width | 480px |

---

## Key Patterns & Conventions

- **Batch modes are plug-and-play.** All mode-specific UI logic lives in `src/workflows/`. `NewBatchDrawer`, `BatchDetail`, `RunDetail`, and `RunCard` delegate to `getWorkflowUI(mode)` from the registry — adding a new mode only requires a new file in `workflows/` and a registry entry. See `WORKFLOWS.md` for the full guide.
- **Signals for global state, `useState` for local UI state** (form fields, loading flags, toggle states inside a single component).
- **`useEffect` + `useRef`** for DOM side-effects: dialog open/close, debounce timers, focus management.
- **No routing library.** Navigation is entirely signal-driven (`selectedBatchId`, `selectedRunId`, `activeTab`). Do not add a router without discussion.
- **Markdown always sanitized.** Never call `marked.parse` directly; go through `renderMarkdown()` in `utils/markdown.ts`.
- **Toast for user feedback.** Import `addToast` from `store.ts` and call it from catch blocks and success handlers.
- **Debounce project inspection.** The 600ms debounce in `NewBatchDrawer` avoids hammering `/api/project/inspect` while the user types.
- **Batch detail is cached.** `batchDetails` is a Map. Only fetch a batch's detail if it is not already in the Map, or when SSE pushes an update.

---

## Adding a New Component

1. Create `src/components/MyComponent.tsx` (or `src/dialogs/` for modal/drawer).
2. Read signals directly — no props needed for global state:
   ```tsx
   import { selectedBatchId } from "../state/store";
   export function MyComponent() {
     return <div>{selectedBatchId.value}</div>;
   }
   ```
3. For local state use `useState`/`useReducer` as normal.
4. Add any new API call to `api.ts` with a typed return value.
5. Wire into `App.tsx` if it is a top-level element.

## Adding a New API Endpoint

1. Add the typed function to `src/state/api.ts`.
2. Update `src/types.ts` with any new request/response types.
3. Ensure the backend endpoint exists in `src/server.ts` (backend is unchanged by frontend changes).
