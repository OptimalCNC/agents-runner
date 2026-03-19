import fs from "node:fs/promises";
import path from "node:path";

import { normalizeTerminalPreference } from "./terminal";

import type { TerminalPreference } from "../types";

export interface AppSettings {
  worktreeRoot: string;
  terminal: {
    preference: TerminalPreference;
  };
}

export interface AppSettingsStore {
  load(): Promise<void>;
  get(): AppSettings;
  update(patch: Partial<AppSettings>): Promise<AppSettings>;
}

const DEFAULT_APP_SETTINGS: AppSettings = {
  worktreeRoot: "",
  terminal: {
    preference: "auto",
  },
};

function cloneSettings(settings: AppSettings): AppSettings {
  return {
    worktreeRoot: settings.worktreeRoot,
    terminal: {
      preference: settings.terminal.preference,
    },
  };
}

function normalizeWorktreeRoot(value: unknown): string {
  const normalized = String(value ?? "").trim();
  return normalized ? path.resolve(normalized) : "";
}

function normalizeAppSettings(value: unknown): AppSettings {
  const record = value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
  const terminalRecord = record.terminal && typeof record.terminal === "object"
    ? record.terminal as Record<string, unknown>
    : {};

  return {
    worktreeRoot: normalizeWorktreeRoot(record.worktreeRoot),
    terminal: {
      preference: normalizeTerminalPreference(terminalRecord.preference),
    },
  };
}

export function createAppSettingsStore(dataDirectory: string): AppSettingsStore {
  const settingsPath = path.join(dataDirectory, "settings.json");
  let settings = cloneSettings(DEFAULT_APP_SETTINGS);
  let writeQueue: Promise<unknown> = Promise.resolve();

  async function persist(snapshot: AppSettings): Promise<void> {
    await fs.mkdir(dataDirectory, { recursive: true });
    await fs.writeFile(settingsPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  }

  async function enqueueWrite(snapshot: AppSettings): Promise<void> {
    const task = async () => {
      await persist(snapshot);
    };

    const run = writeQueue.then(task, task);
    writeQueue = run.catch(() => {});
    await run;
  }

  return {
    async load() {
      await fs.mkdir(dataDirectory, { recursive: true });

      try {
        const raw = await fs.readFile(settingsPath, "utf8");
        settings = normalizeAppSettings(JSON.parse(raw));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          settings = cloneSettings(DEFAULT_APP_SETTINGS);
          return;
        }

        throw error;
      }
    },

    get() {
      return cloneSettings(settings);
    },

    async update(patch) {
      settings = normalizeAppSettings({
        ...settings,
        ...patch,
        terminal: {
          ...settings.terminal,
          ...patch.terminal,
        },
      });

      const snapshot = cloneSettings(settings);
      await enqueueWrite(snapshot);
      return snapshot;
    },
  };
}
