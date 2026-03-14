export interface FilePatch {
  fileName: string;
  patch: string;
  additions: number;
  deletions: number;
  isNew: boolean;
  isDeleted: boolean;
  isBinary: boolean;
}

function splitRawDiffIntoChunks(diffText: string): string[] {
  const normalized = diffText.trim();
  if (!normalized) {
    return [];
  }

  const chunks = normalized
    .split(/^diff --git\s+/gm)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => (segment.startsWith("a/") ? `diff --git ${segment}` : segment));

  return chunks;
}

function parsePatchFileName(patch: string): string {
  const plusLine = patch.match(/^\+\+\+\s+([^\n\r]+)/m)?.[1]?.trim();
  const minusLine = patch.match(/^---\s+([^\n\r]+)/m)?.[1]?.trim();
  const gitHeader = patch.match(/^diff --git\s+a\/(.+?)\s+b\/(.+)$/m);

  const pickCandidate = (value: string | undefined): string | null => {
    if (!value || value === "/dev/null") return null;
    if (value.startsWith("a/") || value.startsWith("b/")) return value.slice(2);
    return value;
  };

  return pickCandidate(plusLine)
    || pickCandidate(minusLine)
    || gitHeader?.[2]?.trim()
    || gitHeader?.[1]?.trim()
    || "unknown-file";
}

function countPatchStats(patch: string) {
  let additions = 0;
  let deletions = 0;

  for (const line of patch.split("\n")) {
    if (line.startsWith("+++ ") || line.startsWith("--- ")) {
      continue;
    }
    if (line.startsWith("+")) {
      additions += 1;
      continue;
    }
    if (line.startsWith("-")) {
      deletions += 1;
    }
  }

  return { additions, deletions };
}

export function splitDiff(diffText: string | null | undefined): FilePatch[] {
  const chunks = splitRawDiffIntoChunks(String(diffText ?? ""));

  return chunks.map((patch) => {
    const { additions, deletions } = countPatchStats(patch);
    const isBinary = /(^|\n)(Binary files .+ differ|GIT binary patch)(\n|$)/m.test(patch);
    const isNew = /(^|\n)new file mode\s/m.test(patch) || /(^|\n)---\s+\/dev\/null(\n|$)/m.test(patch);
    const isDeleted = /(^|\n)deleted file mode\s/m.test(patch) || /(^|\n)\+\+\+\s+\/dev\/null(\n|$)/m.test(patch);

    return {
      fileName: parsePatchFileName(patch),
      patch,
      additions,
      deletions,
      isNew,
      isDeleted,
      isBinary,
    };
  });
}
