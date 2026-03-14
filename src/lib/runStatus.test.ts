import { expect, test } from "bun:test";

import { ACTIVE_RUN_STATUSES, isRunActiveStatus, isRunPendingStatus, isRunTerminalStatus } from "./runStatus";

test("ACTIVE_RUN_STATUSES includes local setup, Codex wait, and active execution", () => {
  expect(ACTIVE_RUN_STATUSES).toEqual(["preparing", "waiting_for_codex", "running"]);
});

test("isRunActiveStatus only matches active execution phases", () => {
  expect(isRunActiveStatus("queued")).toBe(false);
  expect(isRunActiveStatus("preparing")).toBe(true);
  expect(isRunActiveStatus("waiting_for_codex")).toBe(true);
  expect(isRunActiveStatus("running")).toBe(true);
  expect(isRunActiveStatus("completed")).toBe(false);
});

test("isRunPendingStatus covers both local queueing and active phases", () => {
  expect(isRunPendingStatus("queued")).toBe(true);
  expect(isRunPendingStatus("preparing")).toBe(true);
  expect(isRunPendingStatus("waiting_for_codex")).toBe(true);
  expect(isRunPendingStatus("running")).toBe(true);
  expect(isRunPendingStatus("failed")).toBe(false);
});

test("isRunTerminalStatus only matches finished phases", () => {
  expect(isRunTerminalStatus("completed")).toBe(true);
  expect(isRunTerminalStatus("failed")).toBe(true);
  expect(isRunTerminalStatus("cancelled")).toBe(true);
  expect(isRunTerminalStatus("waiting_for_codex")).toBe(false);
});
