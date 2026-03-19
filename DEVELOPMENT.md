# Development Guide

This guide covers local development for Agents Runner. For the product overview and runtime behavior, see [README.md](README.md). For workflow architecture and adding new batch modes, see [WORKFLOWS.md](WORKFLOWS.md). For the native terminal launcher architecture and extension points, see [docs/open-in-terminal.md](docs/open-in-terminal.md).

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

## Feature Guides

Use these guides when you are extending subsystems beyond workflow logic:

- [docs/open-in-terminal.md](docs/open-in-terminal.md): architecture of the native `Open Terminal` feature, launch lifecycle, and how to add a new terminal launcher
