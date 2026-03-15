import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function hasCodexProfile(): Promise<boolean> {
  try {
    await fsp.access(path.join(os.homedir(), ".codex", "auth.json"));
    return true;
  } catch {
    return false;
  }
}

export async function hasCodexCredentials(): Promise<boolean> {
  return Boolean(process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY || await hasCodexProfile());
}

