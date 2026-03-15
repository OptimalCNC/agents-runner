import path from "node:path";
import { fileURLToPath } from "node:url";

import { createBatchStore } from "../lib/batchStore";
import { createCodexModelCatalog } from "../lib/codexModels";

import { DEFAULT_PORT } from "./constants";

import type { BatchStore, ModelCatalog } from "../types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface ServerContext {
  projectRoot: string;
  publicDirectory: string;
  port: number;
  store: BatchStore;
  modelCatalog: ModelCatalog;
}

export function createServerContext(): ServerContext {
  const projectRoot = path.resolve(__dirname, "../..");
  const publicDirectory = path.join(projectRoot, "public");
  const dataDirectory = path.join(projectRoot, "data");

  return {
    projectRoot,
    publicDirectory,
    port: Number(process.env.PORT || DEFAULT_PORT),
    store: createBatchStore(dataDirectory),
    modelCatalog: createCodexModelCatalog(),
  };
}

