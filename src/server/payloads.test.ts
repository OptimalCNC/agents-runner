import { expect, test } from "bun:test";

import { normalizeCreateBatchPayload } from "./payloads";

test("ranked payload allows concurrency above run count and caps it by review capacity", () => {
  const payload = normalizeCreateBatchPayload({
    mode: "ranked",
    projectPath: "/tmp/example-project",
    prompt: "Implement ranked scheduling.",
    reviewPrompt: "Score the implementation.",
    runCount: 2,
    concurrency: 99,
    reviewCount: 5,
  });

  expect(payload.config.runCount).toBe(2);
  expect(payload.config.reviewCount).toBe(5);
  expect(payload.config.concurrency).toBe(10);
});
