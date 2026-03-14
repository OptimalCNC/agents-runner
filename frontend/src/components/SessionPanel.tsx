import { useEffect, useMemo, useRef, useState } from "react";

import { apiContinueRun } from "../state/api.js";
import { useAppStore } from "../state/store.js";
import type { Run, RunTurn, StreamItem } from "../types.js";
import { formatDate } from "../utils/format.js";
import { renderMarkdown } from "../utils/markdown.js";
import { isPendingRunStatus } from "../utils/runStatus.js";
import { BotIcon, PlayIcon, ChevronRightIcon } from "../icons.js";
import { StreamItemView, getStreamItemGroupMeta } from "./StreamItemView.js";

interface Props {
  batchId: string;
  run: Run;
}

type SessionItemEntry =
  | { kind: "item"; item: StreamItem }
  | { kind: "group"; groupKey: string; items: StreamItem[] };

function getSessionTurns(run: Run): RunTurn[] {
  if (run.turns.length > 0) {
    return run.turns;
  }

  return [{
    id: `turn-fallback-${run.id}`,
    index: 0,
    prompt: run.prompt,
    status: run.status,
    submittedAt: run.startedAt || run.completedAt || new Date().toISOString(),
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    finalResponse: run.finalResponse,
    error: run.error,
    usage: run.usage,
    items: run.items,
  }];
}

function canContinueRun(run: Run): boolean {
  if (isPendingRunStatus(run.status)) {
    return false;
  }

  return Boolean(run.threadId && run.workingDirectory);
}

function buildOptimisticTurn(run: Run, prompt: string): RunTurn {
  return {
    id: `optimistic-turn-${Date.now()}`,
    index: run.turns.length,
    prompt,
    status: "waiting_for_codex",
    submittedAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    finalResponse: "",
    error: null,
    usage: null,
    items: [],
  };
}

function getTurnPlaceholder(status: RunTurn["status"], isSubmitting: boolean): string {
  if (isSubmitting) {
    return "Sending follow-up to Codex...";
  }

  switch (status) {
    case "queued":
      return "Waiting for an available local concurrency slot...";
    case "preparing":
      return "Preparing the worktree and starting Codex...";
    case "waiting_for_codex":
      return "Codex thread is ready. Waiting for the turn to begin...";
    case "running":
      return "Codex is working on this turn...";
    default:
      return "No streamed activity recorded.";
  }
}

function getGroupKey(item: StreamItem): string | null {
  if (getStreamItemGroupMeta(item)) {
    return item.type;
  }
  return null;
}

function groupTurnItems(items: StreamItem[]): SessionItemEntry[] {
  const entries: SessionItemEntry[] = [];

  for (let index = 0; index < items.length; index += 1) {
    const currentItem = items[index];
    const currentGroupKey = getGroupKey(currentItem);
    if (!currentGroupKey) {
      entries.push({ kind: "item", item: currentItem });
      continue;
    }

    const groupedItems = [currentItem];
    let nextIndex = index + 1;
    while (nextIndex < items.length && getGroupKey(items[nextIndex]) === currentGroupKey) {
      groupedItems.push(items[nextIndex]);
      nextIndex += 1;
    }

    if (groupedItems.length >= 2) {
      entries.push({
        kind: "group",
        groupKey: currentGroupKey,
        items: groupedItems,
      });
      index = nextIndex - 1;
      continue;
    }

    entries.push({ kind: "item", item: currentItem });
  }

  return entries;
}

function ToolGroup({ items }: { items: StreamItem[] }) {
  const firstItem = items[0];
  const meta = getStreamItemGroupMeta(firstItem);

  if (!meta) {
    return items.map((item) => (
      <StreamItemView key={item.id} item={item} />
    ));
  }

  const count = items.length;
  const noun = count === 1 ? meta.singular : meta.plural;
  const category = items.some((item) => getStreamItemGroupMeta(item)?.category === "danger")
    ? "danger"
    : meta.category;

  return (
    <details className={`tx-tool-group tx-collapsible-${category}`}>
      <summary>
        <div className="tx-collapsible-summary">
          <span className="tx-collapsible-chevron">
            <ChevronRightIcon size={13} />
          </span>
          <span className="tx-collapsible-icon">{meta.icon}</span>
          <span className="tx-collapsible-copy">
            <span className="tx-collapsible-label">{meta.label}</span>
            <span className="tx-collapsible-title">{count} {noun}</span>
          </span>
        </div>
      </summary>
      <div className="tx-tool-group-list">
        {items.map((item) => (
          <StreamItemView key={item.id} item={item} grouped />
        ))}
      </div>
    </details>
  );
}

export function SessionPanel({ batchId, run }: Props) {
  const [prompt, setPrompt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [pendingTurn, setPendingTurn] = useState<RunTurn | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const turns = useMemo(() => getSessionTurns(run), [run]);
  const displayTurns = useMemo(() => {
    if (!submitting || !pendingTurn) {
      return turns;
    }

    const alreadyMaterialized = turns.some((turn) =>
      turn.index === pendingTurn.index && turn.prompt === pendingTurn.prompt,
    );

    return alreadyMaterialized ? turns : [...turns, pendingTurn];
  }, [pendingTurn, submitting, turns]);
  const isRunnable = canContinueRun(run);
  const isRunActive = isPendingRunStatus(run.status);
  const composerDisabled = submitting || isRunActive || !Boolean(run.threadId && run.workingDirectory);
  const submitLabel = submitting ? "Sending..." : isRunActive ? "Working..." : "Continue Run";

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) {
      return;
    }

    scroller.scrollTop = scroller.scrollHeight;
  }, [displayTurns.length, run.items.length]);

  useEffect(() => {
    setPendingTurn(null);
  }, [run.id]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const nextPrompt = prompt.trim();
    if (!nextPrompt || submitting || !isRunnable) {
      return;
    }

    setPendingTurn(buildOptimisticTurn(run, nextPrompt));
    setPrompt("");
    setSubmitting(true);
    try {
      const payload = await apiContinueRun(batchId, run.id, nextPrompt);
      useAppStore.getState().setBatchDetail(payload.batch);
    } catch (error) {
      setPrompt(nextPrompt);
      useAppStore.getState().addToast("error", "Continue failed", (error as Error).message);
    } finally {
      setPendingTurn(null);
      setSubmitting(false);
    }
  }

  return (
    <section className="session-panel">
      <div ref={scrollRef} className="session-scroll">
        <div className="session-thread">
          {displayTurns.map((turn, index) => (
            <div key={turn.id} className="tx-turn">
              <div className="tx-turn-divider">
                <span>Turn {index + 1}</span>
              </div>

              <div className="tx-user-row">
                <div className="tx-user-card">
                  <div
                    className="markdown-body"
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(turn.prompt) }}
                  />
                  <div className="tx-user-meta">You · {formatDate(turn.submittedAt)}</div>
                </div>
              </div>

              <div className="tx-agent-row">
                <div className="tx-agent-avatar"><BotIcon size={15} /></div>
                <div className="tx-agent-stack">
                  <div className="tx-agent-header">
                    <span className="tx-agent-name">Codex</span>
                    <span className="tx-agent-meta">
                      {formatDate(turn.startedAt || turn.submittedAt)}
                    </span>
                  </div>

                  {turn.items.length === 0 ? (
                    <div className="tx-agent-placeholder">
                      {getTurnPlaceholder(turn.status, submitting && pendingTurn?.id === turn.id)}
                    </div>
                  ) : (
                    groupTurnItems(turn.items).map((entry, entryIndex) => (
                      entry.kind === "item"
                        ? <StreamItemView key={entry.item.id} item={entry.item} />
                        : <ToolGroup key={`${turn.id}-${entry.groupKey}-${entryIndex}`} items={entry.items} />
                    ))
                  )}

                  {turn.error && (
                    <div className="tx-inline-error tx-inline-error-strong">
                      {turn.error}
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <form className="session-composer" onSubmit={handleSubmit}>
        <div className="session-composer-shell">
          <textarea
            className="session-textarea"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder={
              submitting
                ? "Sending follow-up to Codex..."
                : isRunnable
                ? "Send a follow-up message to continue this run..."
                : isPendingRunStatus(run.status)
                ? "Wait for the current turn to finish before sending another message."
                : "This run cannot be continued until it has a thread and working directory."
            }
            rows={4}
            disabled={composerDisabled}
          />
          <div className="session-composer-footer">
            <div className="session-composer-hint">
              {run.workingDirectory || "No working directory yet."}
            </div>
            <button
              className="btn btn-primary session-submit"
              type="submit"
              disabled={composerDisabled || !prompt.trim()}
            >
              <PlayIcon size={12} /> {submitLabel}
            </button>
          </div>
        </div>
      </form>
    </section>
  );
}
