# Agents Runner

A lightweight web UI for running multiple Codex SDK runs in parallel, each isolated in its own git worktree. Runs are organized into batches.

## Quick Start

**Requirements:** [Bun](https://bun.sh/) 1.0+ and Git (used to create isolated worktrees for each run).

```bash
bun install
bun run start
```

Open [http://localhost:3000](http://localhost:3000) to launch the UI.

## Credentials

Agents Runner uses the Codex SDK, which needs credentials to talk to a model provider.

1. **API key** &mdash; if `OPENAI_API_KEY` (or `CODEX_API_KEY`) is set in the environment, the SDK uses it directly.
2. **Existing login** &mdash; if no API key is set, the SDK looks for credentials already stored on your machine (typically `~/.codex/auth.json`). If you have logged in through the Codex CLI or an IDE extension, the credentials are picked up automatically &mdash; no extra setup needed.

## Batch Modes

### Repeated

Give a single prompt and run it across N runs in parallel. Each run works in its own worktree from the same starting point. Useful for benchmarking, comparing approaches, or running the same task with different behavior.

### Generated

Provide a high-level prompt and let Codex split it into N distinct tasks automatically. Each generated task is then executed by its own run in a separate worktree. Useful for parallelizing large refactors or multi-file work across independent runs.

## How It Works

1. **Pick a project** &mdash; select any git repository (or a subdirectory within one). The app validates it and detects the branch and HEAD commit.
2. **Configure the batch** &mdash; choose a mode, set the number of runs and concurrency, write your prompt, and optionally tune model, sandbox, and approval settings.
3. **Start** &mdash; the app creates isolated git worktrees and launches runs in parallel. Progress streams back in real time.
4. **Review** &mdash; inspect each run's final response, git diff, logs, and streamed items from a single dashboard.

## Configuration

| Setting | Description |
|---|---|
| **Project Folder** | Path to your git repo or a subdirectory inside one. |
| **Worktree Root** | Where worktrees are created. Defaults to the project's parent directory. |
| **Run Count** | Number of runs to launch (1 &ndash; 50). |
| **Concurrency** | Max runs executing at the same time. |
| **Base Ref** | Git ref to branch worktrees from. Defaults to HEAD. |
| **Model** | Override the default Codex model. |
| **Sandbox** | `workspace-write` (default), `read-only`, or `danger-full-access`. |
| **Approval Policy** | `never` (default), `on-request`, `on-failure`, or `untrusted`. |

## Data Storage

Each batch is stored in its own folder under `data/batches/<batchId>/`:

```
data/batches/<batchId>/batch.json       # Batch metadata and config
data/batches/<batchId>/runs/<runId>.json # Individual run data
```

## Good to Know

- Worktrees are **not deleted automatically** after a batch completes. Clean them up manually or reuse the worktree root across batches.
- If you select a subdirectory rather than the repo root, each run still gets a full worktree but runs from the matching subdirectory within it.
- Worktree folders are named `<project>-<ref>-<index>` (e.g. `my-app-main-3`).
- You can cancel a running batch at any time; runs that have already completed keep their results.
