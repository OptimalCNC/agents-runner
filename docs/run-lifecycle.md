# Run Lifecycle

This document is the source of truth for per-run lifecycle controls, batch status derivation, and workflow-specific blocking behavior.

## Goals

- Users can resolve a single stuck or failed run without cancelling the whole batch.
- Failed prerequisite runs in staged workflows do not silently unblock downstream stages.
- A rerun replaces the previous attempt on the same run card.
- A resume continues the same Codex thread instead of starting over.

## Run Actions

### Stop

- Allowed for `queued`, `preparing`, `waiting_for_codex`, and `running` runs.
- Also allowed for `failed` runs that are currently blocking workflow progress.
- Result:
  - queued run: becomes `cancelled`
  - active run: aborts and becomes `cancelled`
  - failed blocking run: becomes explicitly `cancelled`
- After stop, the scheduler re-evaluates the batch immediately.

### Rerun

- Allowed for active runs and terminal `failed` / `cancelled` runs.
- If the run is active, it is aborted first.
- The previous in-app attempt is cleared in place:
  - turns
  - stream items
  - logs
  - review metadata
  - usage
  - error/final response
  - thread/worktree/working directory/base ref
  - follow-up reopen flags
  - score/rank fields
- The same run id and card remain; a fresh attempt is queued and then scheduled.

### Resume

- Allowed only for `failed` runs with both `threadId` and `workingDirectory`.
- Starts a new turn on the existing Codex thread with a built-in recovery prompt.
- Resume is not the same as a normal follow-up turn:
  - `resume` is failure recovery on the existing failed run
  - follow-ups are extra turns after a settled run, subject to workflow follow-up policy

## Run Statuses

Run statuses remain:

- `queued`
- `preparing`
- `waiting_for_codex`
- `running`
- `completed`
- `failed`
- `cancelled`

`Stop` uses `cancelled`. There is no separate `stopped` status.

## Batch Statuses

Batch statuses are:

- `queued`
- `running`
- `blocked`
- `failed`
- `completed`
- `cancelled`

### Derivation Rules

1. `cancelled`
   - `cancelRequested` is true and all runs are terminal.

2. `running`
   - any run is actively executing (`preparing`, `waiting_for_codex`, `running`), or
   - at least one queued run is ready to start now.

3. `blocked`
   - no runs are active
   - no queued runs are ready
   - one or more failed runs are still blocking downstream workflow progress

4. `failed`
   - the batch has unresolved failed runs, but they are not represented as workflow blockers
   - or the batch itself failed before normal scheduling could complete

5. `completed`
   - all required work is resolved
   - explicitly stopped runs may be `cancelled`

## Workflow-Specific Blocking Rules

### repeated

- No staged dependencies.
- Failed runs do not create `blocked`.
- Batch stays `failed` until the failed run is rerun or resumed.

### generated

- Same lifecycle behavior as `repeated` after task generation finishes.
- Failed runs do not create `blocked`.

### ranked

- Reviewer runs are created up front and wait in `queued`.
- A reviewer becomes ready only after its candidate completed and produced a working directory.
- Failed candidate:
  - blocks reviewer start
  - batch becomes `blocked` when no other active or ready work remains
- Failed reviewer:
  - blocks final ranked settlement
  - batch becomes `blocked` when no other active or ready work remains
- Stopping a candidate cancels its queued reviewers.
- Rerunning a candidate resets that candidate plus all of its reviewers.
- Rerunning a reviewer resets only that reviewer.

### validated

- The validator run is created up front and waits in `queued`.
- The validator becomes ready only after every worker is resolved (`completed` or explicitly `cancelled`).
- Failed worker:
  - blocks validator start
  - batch becomes `blocked` when no other active or ready work remains
- Failed validator:
  - blocks batch settlement
  - batch becomes `blocked` when no other active or ready work remains
- Rerunning a worker resets that worker plus the validator.
- Rerunning the validator resets only the validator.

## Allowed Actions By Run State

| Run state            | Stop | Rerun | Resume |
| -------------------- | ---- | ----- | ------ |
| `queued`             | yes  | yes   | no     |
| `preparing`          | yes  | yes   | no     |
| `waiting_for_codex`  | yes  | yes   | no     |
| `running`            | yes  | yes   | no     |
| `completed`          | no   | no    | no     |
| `failed`             | yes, if blocking | yes | yes, if thread + working directory exist |
| `cancelled`          | no   | yes   | no     |

## Examples

### Ranked Candidate Failure

1. Candidate `run-1` fails.
2. Its reviewer runs stay queued but not ready.
3. No other active or ready work remains.
4. Batch becomes `blocked`.
5. User chooses one of:
   - `Stop`: candidate becomes `cancelled`, queued reviewers are cancelled, batch can settle
   - `Rerun`: candidate and its reviewers reset to fresh queued attempts
   - `Resume`: candidate continues on the same thread; if it completes, reviewers can start

### Validated Worker Rerun

1. Worker `run-2` failed and blocked the validator.
2. User clicks `Rerun`.
3. `run-2` resets to a fresh queued attempt.
4. Validator resets too, because the old validation would be stale.
5. Batch returns to `running` once `run-2` is ready to start.

## API Endpoints

- `POST /api/batches/:batchId/runs/:runId/stop`
- `POST /api/batches/:batchId/runs/:runId/rerun`
- `POST /api/batches/:batchId/runs/:runId/resume`

Each endpoint returns the updated batch payload so the UI can refresh the selected run and batch status immediately.
