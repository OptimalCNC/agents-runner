# Development Guide

This guide covers local development for Agents Runner. For the product overview and runtime behavior, see [README.md](README.md). For workflow architecture and adding new batch modes, see [WORKFLOWS.md](WORKFLOWS.md). For the run state machine and lifecycle actions, see [docs/run-lifecycle.md](docs/run-lifecycle.md). For the native terminal launcher architecture and extension points, see [docs/open-in-terminal.md](docs/open-in-terminal.md).

## Development Principles

This project is still in an early internal stage. Prefer the best implementation for the current codebase, and do not add compatibility layers or migration code.

## Requirements

- [Bun](https://bun.sh/) 1.0+
- Git
- Codex credentials, provided by either:
  - `OPENAI_API_KEY` or `CODEX_API_KEY`
  - an existing Codex login on the machine, typically at `~/.codex/auth.json`

## Install Dependencies

```bash
bun install
```

The root `postinstall` also installs frontend dependencies.

## Run Locally

Start the backend and frontend in separate terminals:

```bash
# Terminal 1
bun run dev:backend

# Terminal 2
bun run dev:frontend
```

- Backend: `http://localhost:3000`
- Frontend dev server: `http://localhost:5173`

The Vite frontend proxies `/api` and `/events` to the backend.

## Useful Commands

```bash
bun run build:frontend
bun run start
bun test
bun run typecheck
```

Frontend-only checks:

```bash
cd frontend
bun test ./test
bun run typecheck
```

## Workflow Development

Workflow modes are implemented as modules in `src/lib/workflows/` and mirrored by UI modules in `frontend/src/workflows/`.

Use [WORKFLOWS.md](WORKFLOWS.md) when you need to:

- understand the workflow registry and module interfaces
- add a new batch mode
- update workflow-specific tests

Use [docs/run-lifecycle.md](docs/run-lifecycle.md) when you need to:

- change batch status derivation
- change `stop`, `rerun`, or `resume`
- modify which failed runs should block downstream stages
- update rerun dependency reset behavior

## Lifecycle Regression Expectations

When changing scheduler or workflow behavior, remember that failed runs in staged workflows do not auto-unblock downstream work. Consult [docs/run-lifecycle.md](docs/run-lifecycle.md) and [WORKFLOWS.md](WORKFLOWS.md) before changing run lifecycle semantics.

Any change to the runner scheduler, workflow readiness, or staged workflow dependencies should keep these checks covered:

- stopping a queued run leaves it cancelled and never launches it
- stopping an active run aborts it cleanly and frees scheduler capacity
- rerunning a run resets the old attempt in place
- resuming a failed run continues on the existing thread
- ranked and validated blocked-state transitions still behave correctly
- loader normalization after restart preserves queued blocked downstream runs instead of auto-failing them
- repeated and generated batches do not enter `blocked`

## Feature Guides

Use these guides when you are extending subsystems beyond workflow logic:

- [docs/open-in-terminal.md](docs/open-in-terminal.md): architecture of the native `Open Terminal` feature, launch lifecycle, and how to add a new terminal launcher
