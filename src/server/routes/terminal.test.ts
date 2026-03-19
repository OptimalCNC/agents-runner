import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, expect, test } from "bun:test";

import { createTerminalRouteHandler } from "./terminal";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function createTempDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agents-runner-terminal-route-"));
  tempDirectories.push(directory);
  return directory;
}

async function invokeTerminalRoute(
  handler: ReturnType<typeof createTerminalRouteHandler>,
  body: Record<string, unknown>,
) {
  const request = new PassThrough() as PassThrough & { method?: string; headers?: Record<string, string> };
  request.method = "POST";
  request.headers = {
    host: "localhost:3000",
  };

  let statusCode = 0;
  let responseText = "";
  const response = {
    writeHead(code: number) {
      statusCode = code;
      return this;
    },
    end(chunk?: string | Buffer) {
      responseText += chunk ? chunk.toString() : "";
    },
  };

  const routePromise = handler({
    settings: {
      get: () => ({
        worktreeRoot: "",
        terminal: {
          preference: "auto",
        },
      }),
    },
  } as never, request as never, response as never, new URL("http://localhost:3000/api/terminal/launch"));

  queueMicrotask(() => {
    request.emit("data", Buffer.from(JSON.stringify(body)));
    request.emit("end");
  });

  await routePromise;

  return {
    statusCode,
    body: responseText ? JSON.parse(responseText) as { error?: string; launched?: boolean } : {},
  };
}

test("terminal launch route rejects missing path", async () => {
  const result = await invokeTerminalRoute(createTerminalRouteHandler(), {
    clientPlatform: "windows",
  });

  expect(result.statusCode).toBe(400);
  expect(result.body.error).toBe("Path is required.");
});

test("terminal launch route rejects relative paths", async () => {
  const result = await invokeTerminalRoute(createTerminalRouteHandler(), {
    path: "relative/path",
    clientPlatform: "windows",
  });

  expect(result.statusCode).toBe(400);
  expect(result.body.error).toBe("Path must be absolute.");
});

test("terminal launch route rejects nonexistent directories", async () => {
  const result = await invokeTerminalRoute(createTerminalRouteHandler(), {
    path: "/tmp/agents-runner-missing-terminal-path",
    clientPlatform: "windows",
  });

  expect(result.statusCode).toBe(404);
  expect(result.body.error).toBe("Directory not found.");
});

test("terminal launch route accepts a valid directory", async () => {
  const directory = await createTempDirectory();
  const launches: Array<{ path: string; clientPlatform: string }> = [];

  const result = await invokeTerminalRoute(createTerminalRouteHandler({
    launch: async (options) => {
      launches.push({
        path: options.path,
        clientPlatform: options.clientPlatform,
      });
      return {
        launcherId: "windows-terminal",
        launcherLabel: "Windows Terminal",
      };
    },
  }), {
    path: directory,
    clientPlatform: "windows",
  });

  expect(result.statusCode).toBe(202);
  expect(result.body.launched).toBe(true);
  expect(launches).toEqual([{
    path: directory,
    clientPlatform: "windows",
  }]);
});
