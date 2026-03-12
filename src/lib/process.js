import { spawn } from "node:child_process";

function toError(message, context = {}) {
  const error = new Error(message);
  Object.assign(error, context);
  return error;
}

export function isAbortError(error) {
  return (
    error?.name === "AbortError" ||
    error?.code === "ABORT_ERR" ||
    /aborted|cancelled|canceled/i.test(String(error?.message ?? ""))
  );
}

export function runCommand(command, args, options = {}) {
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

    const finalize = (handler) => {
      if (finished) {
        return;
      }
      finished = true;
      signal?.removeEventListener("abort", abortHandler);
      handler();
    };

    const abortHandler = () => {
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

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      finalize(() => reject(error));
    });

    child.on("close", (code, receivedSignal) => {
      const result = {
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
