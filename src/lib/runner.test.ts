import { expect, test } from "bun:test";

import { createRunId } from "./runner";

test("createRunId returns a stable run id derived from the run index", () => {
  const id = createRunId(0);

  expect(id).toBe("run-1");
});

test("createRunId increments with the run index", () => {
  expect(createRunId(1)).toBe("run-2");
  expect(createRunId(9)).toBe("run-10");
});
