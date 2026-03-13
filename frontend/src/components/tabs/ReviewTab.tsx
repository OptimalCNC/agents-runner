import { useState } from "react";
import type { Run } from "../../types.js";
import { useAppStore, selectSelectedBatch } from "../../state/store.js";
import { apiGetRunReview } from "../../state/api.js";
import { RefreshIcon } from "../../icons.js";

interface Props {
  run: Run;
}

export function ReviewTab({ run }: Props) {
  const [refreshing, setRefreshing] = useState(false);
  const batch = useAppStore(selectSelectedBatch);

  async function handleRefresh() {
    if (!batch) return;
    setRefreshing(true);
    try {
      const payload = await apiGetRunReview(batch.id, run.id);
      useAppStore.setState((s) => {
        const newMap = new Map(s.batchDetails);
        const existing = newMap.get(batch.id);
        if (existing) {
          const updatedRuns = existing.runs.map((r) =>
            r.id === run.id ? { ...r, review: payload.review } : r,
          );
          newMap.set(batch.id, { ...existing, runs: updatedRuns });
        }
        return { batchDetails: newMap };
      });
      useAppStore.getState().addToast("success", "Review refreshed", "Git review data updated.");
    } catch (err) {
      useAppStore.getState().addToast("error", "Review failed", (err as Error).message);
    } finally {
      setRefreshing(false);
    }
  }

  const review = run.review;

  return (
    <div className="tab-panel is-active" data-tab="review">
      <div className="tab-panel-toolbar">
        <button
          className="btn btn-ghost btn-sm"
          type="button"
          disabled={refreshing}
          onClick={handleRefresh}
        >
          <RefreshIcon /> {refreshing ? "Refreshing\u2026" : "Refresh Review"}
        </button>
      </div>
      {!review ? (
        <div className="text-muted text-sm">
          No review data yet. Click "Refresh Review" after the worktree is created.
        </div>
      ) : (
        <>
          <div className="review-section">
            <div className="review-section-title">Git Status</div>
            <pre className="code-block">{review.statusShort || "No tracked changes."}</pre>
          </div>
          <div className="review-section">
            <div className="review-section-title">Diff Stat</div>
            <pre className="code-block">{review.diffStat || "No diff stat available."}</pre>
          </div>
          <div className="review-section">
            <div className="review-section-title">Tracked Diff</div>
            <pre className="code-block">{review.trackedDiff || "No tracked diff."}</pre>
          </div>
          {(review.untrackedFiles || []).map((f, i) => (
            <div key={i} className="review-section">
              <div className="review-section-title">Untracked: {f.path}</div>
              <pre className="code-block">{f.preview}</pre>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
