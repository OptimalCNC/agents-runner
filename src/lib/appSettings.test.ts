import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, test } from "bun:test";

import { createAppSettingsStore } from "./appSettings";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function createTempDataDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agents-runner-app-settings-"));
  tempDirectories.push(directory);
  return directory;
}

test("load falls back to empty settings when the settings file is missing", async () => {
  const dataDirectory = await createTempDataDirectory();
  const store = createAppSettingsStore(dataDirectory);

  await store.load();

  expect(store.get()).toEqual({
    worktreeRoot: "",
    terminal: {
      preference: "auto",
    },
  });
});

test("update persists a normalized worktree root", async () => {
  const dataDirectory = await createTempDataDirectory();
  const store = createAppSettingsStore(dataDirectory);
  const relativeRoot = path.join("tmp", "shared-worktrees");

  await store.load();
  const saved = await store.update({ worktreeRoot: relativeRoot });

  expect(saved).toEqual({
    worktreeRoot: path.resolve(relativeRoot),
    terminal: {
      preference: "auto",
    },
  });

  const reloadedStore = createAppSettingsStore(dataDirectory);
  await reloadedStore.load();
  expect(reloadedStore.get()).toEqual(saved);
});

test("update allows clearing the saved worktree root", async () => {
  const dataDirectory = await createTempDataDirectory();
  const store = createAppSettingsStore(dataDirectory);

  await store.load();
  await store.update({ worktreeRoot: path.join(dataDirectory, "shared-worktrees") });
  const cleared = await store.update({ worktreeRoot: "" });

  expect(cleared).toEqual({
    worktreeRoot: "",
    terminal: {
      preference: "auto",
    },
  });

  const reloadedStore = createAppSettingsStore(dataDirectory);
  await reloadedStore.load();
  expect(reloadedStore.get()).toEqual(cleared);
});

test("update persists the terminal launcher preference", async () => {
  const dataDirectory = await createTempDataDirectory();
  const store = createAppSettingsStore(dataDirectory);

  await store.load();
  const saved = await store.update({
    terminal: {
      preference: "windows-terminal",
    },
  });

  expect(saved).toEqual({
    worktreeRoot: "",
    terminal: {
      preference: "windows-terminal",
    },
  });

  const reloadedStore = createAppSettingsStore(dataDirectory);
  await reloadedStore.load();
  expect(reloadedStore.get()).toEqual(saved);
});
