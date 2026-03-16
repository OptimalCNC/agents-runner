import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, expect, test } from "bun:test";

import {
  buildBundledMcpEndpointUrl,
  getBundledMcpStatus,
  installBundledMcpServer,
} from "./codexMcp";

import type { CommandResult } from "../types";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function createCodexHome(): Promise<string> {
  const codexHome = await fs.mkdtemp(path.join("/tmp", "agents-runner-codex-mcp-test-"));
  tempDirectories.push(codexHome);
  return codexHome;
}

async function writeConfig(codexHome: string, content: string): Promise<void> {
  await fs.mkdir(codexHome, { recursive: true });
  await fs.writeFile(path.join(codexHome, "config.toml"), content);
}

test("getBundledMcpStatus reports missing install when config is absent", async () => {
  const codexHome = await createCodexHome();
  const status = await getBundledMcpStatus(3010, {
    env: { CODEX_HOME: codexHome },
  });

  expect(status.configPath).toBe(path.join(codexHome, "config.toml"));
  expect(status.installed).toBe(false);
  expect(status.healthy).toBe(false);
  expect(status.configuredUrl).toBeNull();
});

test("getBundledMcpStatus reports a healthy install when config matches the expected URL", async () => {
  const codexHome = await createCodexHome();
  const endpointUrl = buildBundledMcpEndpointUrl(3010);

  await writeConfig(codexHome, [
    "[mcp_servers.agents-runner-workflow]",
    `url = "${endpointUrl}"`,
    "",
  ].join("\n"));

  const status = await getBundledMcpStatus(3010, {
    env: { CODEX_HOME: codexHome },
  });

  expect(status.installed).toBe(true);
  expect(status.healthy).toBe(true);
  expect(status.transport).toBe("streamable_http");
  expect(status.configuredUrl).toBe(endpointUrl);
  expect(status.configPath).toBe(path.join(codexHome, "config.toml"));
});

test("getBundledMcpStatus reports repair details when config points to the wrong URL", async () => {
  const codexHome = await createCodexHome();

  await writeConfig(codexHome, [
    "[mcp_servers.agents-runner-workflow]",
    'url = "http://127.0.0.1:9999/mcp/workflow"',
    "",
  ].join("\n"));

  const status = await getBundledMcpStatus(3010, {
    env: { CODEX_HOME: codexHome },
  });

  expect(status.installed).toBe(true);
  expect(status.healthy).toBe(false);
  expect(status.error).toContain("127.0.0.1:9999");
  expect(status.error).toContain("127.0.0.1:3010");
});

test("installBundledMcpServer removes stale config and verifies the repaired install", async () => {
  const codexHome = await createCodexHome();
  const expectedUrl = buildBundledMcpEndpointUrl(3010);
  const recordedArgs: string[][] = [];

  await writeConfig(codexHome, [
    "[mcp_servers.agents-runner-workflow]",
    'url = "http://127.0.0.1:9999/mcp/workflow"',
    "",
  ].join("\n"));

  const result = await installBundledMcpServer(3010, {
    env: { CODEX_HOME: codexHome },
    runner: async (_command, args): Promise<CommandResult> => {
      recordedArgs.push(args);

      if (args[0] === "mcp" && args[1] === "remove") {
        await writeConfig(codexHome, "");
      }

      if (args[0] === "mcp" && args[1] === "add") {
        await writeConfig(codexHome, [
          "[mcp_servers.agents-runner-workflow]",
          `url = "${expectedUrl}"`,
          "",
        ].join("\n"));
      }

      return {
        code: 0,
        signal: null,
        stdout: "",
        stderr: "",
      };
    },
  });

  expect(result.healthy).toBe(true);
  expect(recordedArgs).toEqual([
    ["mcp", "remove", "agents-runner-workflow"],
    ["mcp", "add", "agents-runner-workflow", "--url", expectedUrl],
  ]);
});
