import { useState } from "preact/hooks";
import type { Run } from "../../types.js";
import { selectedBatch, addToast, batchDetails } from "../../state/store.js";
import { apiGetRunReview } from "../../state/api.js";
import { RefreshIcon } from "../../icons.js";

interface Props {
  run: Run;
}

export function ReviewTab({ run }: Props) {
  const [refreshing, setRefreshing] = useState(false);

  async function handleRefresh() {
    const batch = selectedBatch.value;
    if (!batch) return;
    setRefreshing(true);
    try {
      const payload = await apiGetRunReview(batch.id, run.id);
      // Update the run's review in the store
      const newMap = new Map(batchDetails.value);
      const existing = newMap.get(batch.id);
      if (existing) {
        const updatedRuns = existing.runs.map((r) =>
          r.id === run.id ? { ...r, review: payload.review } : r,
        );
        newMap.set(batch.id, { ...existing, runs: updatedRuns });
        batchDetails.value = newMap;
      }
      addToast("success", "Review refreshed", "Git review data updated.");
    } catch (err) {
      addToast("error", "Review failed", (err as Error).message);
    } finally {
      setRefreshing(false);
    }
  }

  const review = run.review;

  return (
    <div class="tab-panel is-active" data-tab="review">
      <div class="tab-panel-toolbar">
        <button
          class="btn btn-ghost btn-sm"
          type="button"
          disabled={refreshing}
          onClick={handleRefresh}
        >
          <RefreshIcon /> {refreshing ? "Refreshing\u2026" : "Refresh Review"}
        </button>
      </div>
      {!review ? (
        <div class="text-muted text-sm">
          No review data yet. Click "Refresh Review" after the worktree is created.
        </div>
      ) : (
        <>
          <div class="review-section">
            <div class="review-section-title">Git Status</div>
            <pre class="code-block">{review.statusShort || "No tracked changes."}</pre>
          </div>
          <div class="review-section">
            <div class="review-section-title">Diff Stat</div>
            <pre class="code-block">{review.diffStat || "No diff stat available."}</pre>
          </div>
          <div class="review-section">
            <div class="review-section-title">Tracked Diff</div>
            <pre class="code-block">{review.trackedDiff || "No tracked diff."}</pre>
          </div>
          {(review.untrackedFiles || []).map((f, i) => (
            <div key={i} class="review-section">
              <div class="review-section-title">Untracked: {f.path}</div>
              <pre class="code-block">{f.preview}</pre>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
