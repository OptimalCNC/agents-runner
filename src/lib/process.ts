import { spawn } from "node:child_process";

import type { CommandResult } from "../types";

interface CommandError extends Error {
  code?: string | number;
  signal?: string | null;
  stdout?: string;
  stderr?: string;
  command?: string;
  args?: string[];
}

function toError(message: string, context: Record<string, unknown> = {}): CommandError {
  const error = new Error(message) as CommandError;
  Object.assign(error, context);
  return error;
}

export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const err = error as Record<string, unknown>;
  return (
    err.name === "AbortError" ||
    err.code === "ABORT_ERR" ||
    /aborted|cancelled|canceled/i.test(String(err.message ?? ""))
  );
}

export interface RunCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  allowFailure?: boolean;
  input?: string;
}

export function runCommand(
  command: string,
  args: string[],
  options: RunCommandOptions = {},
): Promise<CommandResult> {
  const {
    cwd,
    env,
    signal,
    allowFailure = false,
    input,
  } = options;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let finished = false;

    const finalize = (handler: () => void): void => {
      if (finished) {
        return;
      }
      finished = true;
      signal?.removeEventListener("abort", abortHandler);
      handler();
    };

    const abortHandler = (): void => {
      child.kill("SIGTERM");
      finalize(() => reject(toError(`${command} aborted`, { code: "ABORT_ERR" })));
    };

    if (signal?.aborted) {
      abortHandler();
      return;
    }

    signal?.addEventListener("abort", abortHandler, { once: true });

    if (input) {
      child.stdin.write(input);
    }
    child.stdin.end();

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (error: Error) => {
      finalize(() => reject(error));
    });

    child.on("close", (code: number | null, receivedSignal: string | null) => {
      const result: CommandResult = {
        code: code ?? 1,
        signal: receivedSignal ?? null,
        stdout,
        stderr,
      };

      if (code === 0 || allowFailure) {
        finalize(() => resolve(result));
        return;
      }

      finalize(() =>
        reject(
          toError(stderr.trim() || stdout.trim() || `${command} exited with code ${code}`, {
            ...result,
            command,
            args,
          }),
        ),
      );
    });
  });
}
