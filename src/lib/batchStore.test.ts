import { expect, test } from "bun:test";

import { createBatchId } from "./batchStore";

test("createBatchId returns a five-character lowercase base36 id", () => {
  const id = createBatchId(new Set());

  expect(id).toHaveLength(5);
  expect(id).toMatch(/^[a-z0-9]{5}$/);
});

test("createBatchId avoids ids already present in the provided set", () => {
  const ids = new Set<string>();

  for (let index = 0; index < 64; index += 1) {
    const id = createBatchId(ids);
    expect(ids.has(id)).toBe(false);
    ids.add(id);
  }

  expect(ids.size).toBe(64);
});
