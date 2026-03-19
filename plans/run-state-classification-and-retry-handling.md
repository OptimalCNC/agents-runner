# Correct Run State Classification for Codex Stream Retries

## Summary

- The current runner marks a turn as failed too early in `src/lib/runner.ts`: it sets terminal failure on both top-level `error` events and completed `error` items, and later also converts any turn with `turn.error` into `failed`.
- The Codex SDK type contract says `item.type === "error"` is non-fatal and only `turn.failed` is a terminal turn failure.
- Real batch evidence shows transient reconnect warnings can occur before successful completion: `data/batches/rqj9f/runs/run-3.json` and `data/batches/rqj9f/runs/run-5.json` both contain reconnect errors, later `Turn completed` logs, usage, and created commits, but still remain marked `failed`.
- Decision: do not add a new `RunStatus`. Keep retry and transport fallback as warning logs while `run.status` stays `running`. Only terminal signals should set `failed` or `completed`.

## Classification Rules

- `thread.started`, `turn.started`, `item.started`, `item.updated`, and normal `item.completed` updates are non-terminal progress.
- `item.completed` with `item.type === "error"` is non-terminal. Persist the item and log it, but do not set `turn.error` or `turn.status`.
- Top-level event `type === "error"` is treated as a stream warning while the stream is still alive. Log it, but do not mark the run failed immediately.
- Messages that start with `Reconnecting...` or `Falling back from WebSockets to HTTPS transport` should be logged as `warning`, not `error`.
- `turn.failed` is the authoritative terminal failure event.
- `turn.completed` is the authoritative terminal success event. On receipt, store usage, clear any transient error text for the turn, and mark the turn completed.
- Outer stream or exec exceptions are terminal failures only when the turn does not already have strong completion evidence. If `turn.completed` or usage was already observed, keep the run completed and log the exception as a post-completion warning.

## Implementation Changes

- Refactor live event handling in `src/lib/runner.ts` so transient warnings are tracked separately from terminal failure state.
- Replace the current `turn.status = turn.error ? "failed" : "completed"` finalization in `src/lib/runner.ts` with explicit terminal-state logic:
  - completed if `turn.completed` or usage was observed
  - failed only on `turn.failed` or unrecovered outer exception before completion
  - cancelled only on abort or cancel
  - failed with `Run ended without reaching a terminal state.` only if the stream ends cleanly without any terminal event
- Strengthen completion detection in `src/lib/runner.ts`: stop treating `finalResponse` alone as completion evidence. Use usage, `Turn completed.` logs, `Run completed.` or `Follow-up turn completed.` logs, and ranked reviewer score submission instead.
- Add persisted-state repair in `src/lib/batchStore.ts`: if a stored run says `failed` but the latest turn has strong completion evidence, normalize it to `completed` on load and clear the stale transient error.
- Leave `RunStatus` unchanged. `Retrying` remains an operational warning in logs, not a lifecycle enum value.

## Test Plan

- Add runner tests for: `error` item followed by more items and `turn.completed` stays completed.
- Add runner tests for: top-level `error` event with `Reconnecting...` followed by `turn.completed` stays completed.
- Add runner tests for: `turn.completed` emitted, then generator or child exit throws, final state still completed.
- Add runner tests for: top-level `error` event with no later completion and outer exception still ends failed.
- Add runner tests for: real `turn.failed` still ends failed immediately.
- Extend `src/lib/batchStore.test.ts` with persisted runs like `run-3` and `run-5`: stored status `failed`, transient reconnect error text, but usage plus `Turn completed.` log; load must normalize them to `completed`.
- Add a regression test that `finalResponse` without `turn.completed` does not by itself convert a stranded run to completed.

## Assumptions

- The immediate goal is correctness of run status, not a richer retry UI.
- Resume work should build on top of this fix; false failures must be eliminated first so only genuinely failed runs become resumable.
- No compatibility or migration layer is needed beyond deterministic in-memory normalization of already persisted batch data.
