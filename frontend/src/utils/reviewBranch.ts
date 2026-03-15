export function buildDefaultReviewBranchName(batchId: string | null | undefined, runIndex: number): string {
  const normalizedBatchId = String(batchId ?? "").trim() || "pending";
  return `batch/${normalizedBatchId}/${runIndex + 1}`;
}
