# Agents Runner

A lightweight web UI for running multiple Codex SDK runs in parallel, each isolated in its own git worktree. Runs are organized into batches.

## Project Scope & Design Philosophy

1. **Local-first tool** &mdash; Users run the server on their own machine. This is not a hosted service.
2. **Multi-agent architecture** &mdash; Currently supports the Codex SDK. Designed to support additional agent SDKs in the future, but not prematurely abstracted.
3. **Workflow-oriented batch processing** &mdash; Batches are the core unit. Current workflows:
   - **Repeated**: Same prompt dispatched to N parallel agents.
   - **Generated**: A meta-prompt produces N distinct tasks, each executed by its own agent.
   - Future: Multi-stage pipelines (e.g., Generate &rarr; Execute &rarr; Score &rarr; Rank).
4. **Developer-extensible, not user-configurable** &mdash; Users don't build workflows via the UI. Instead, they clone the repo, launch a coding agent, and ask it to implement custom workflows by modifying the source code. The codebase is organized to make this easy.

## Quick Start

**Requirements:** [Bun](https://bun.sh/) 1.0+ and Git (used to create isolated worktrees for each run).

### Production

```bash
bun install              # also installs frontend deps via postinstall
bun run build:frontend   # builds frontend → public/
bun run start            # serves on http://localhost:3000
```

Open [http://localhost:3000](http://localhost:3000) to launch the UI.

### Development

Development setup, local commands, and workflow-extension notes live in [DEVELOPMENT.md](DEVELOPMENT.md).

## Credentials

Agents Runner uses the Codex SDK, which needs credentials to talk to a model provider.

1. **API key** &mdash; if `OPENAI_API_KEY` (or `CODEX_API_KEY`) is set in the environment, the SDK uses it directly.
2. **Existing login** &mdash; if no API key is set, the SDK looks for credentials already stored on your machine (typically `~/.codex/auth.json`). If you have logged in through the Codex CLI or an IDE extension, the credentials are picked up automatically &mdash; no extra setup needed.

## How It Works

1. **Pick a project** &mdash; select any git repository (or a subdirectory within one). The app validates it and detects the branch and HEAD commit.
2. **Configure the batch** &mdash; choose a mode, set the number of runs and concurrency, write your prompt, and optionally tune model and sandbox settings.
3. **Start** &mdash; the app creates isolated git worktrees and launches runs in parallel. Progress streams back in real time.
4. **Review and continue** &mdash; inspect each run in the coding-agent workspace, including session activity, streamed activity, git changes, and logs, then continue the same Codex thread with follow-up messages when needed.

## Configuration

| Setting             | Description                                                              |
| ------------------- | ------------------------------------------------------------------------ |
| **Project Folder**  | Path to your git repo or a subdirectory inside one.                      |
| **Worktree Root**   | Where worktrees are created. Defaults to the project's parent directory. |
| **Run Count**       | Number of runs to launch (1 &ndash; 50).                                 |
| **Concurrency**     | Max runs executing at the same time.                                     |
| **Base Ref**        | Git ref to branch worktrees from. Defaults to HEAD.                      |
| **Model**           | Override the default Codex model.                                        |
| **Sandbox**         | `workspace-write` (default), `read-only`, or `danger-full-access`.       |

> Current restriction: Agents Runner does not support interactive approval requests today. Because batches run through non-interactive Codex SDK threads, approval behavior is effectively `never`, and sandbox-blocked writes are denied instead of prompting for approval.

## Data Storage

Each batch is stored in its own folder under `data/batches/<batchId>/`:

```
data/batches/<batchId>/batch.json       # Batch metadata and config
data/batches/<batchId>/runs/<runId>.json # Individual run data
```

## Good to Know

- Worktrees are **not deleted automatically** after a batch completes. Clean them up manually or reuse the worktree root across batches.
- If you select a subdirectory rather than the repo root, each run still gets a full worktree but runs from the matching subdirectory within it.
- Worktree folders are named `<project>-<branch>-<batch-id>-<run-index>` (e.g. `my-app-main-batch-42-3`).
- You can cancel a running batch at any time; runs that have already completed keep their results.
