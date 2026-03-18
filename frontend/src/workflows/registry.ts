import type { BatchMode } from "../types.js";
import { repeatedWorkflow } from "./repeated.js";
import { generatedWorkflow } from "./generated.js";
import { rankedWorkflow } from "./ranked.js";
import type { WorkflowUI } from "./types.js";

const workflows = new Map<BatchMode, WorkflowUI>([
  ["repeated", repeatedWorkflow],
  ["generated", generatedWorkflow],
  ["ranked", rankedWorkflow],
]);

export function getWorkflowUI(mode: BatchMode): WorkflowUI {
  const wf = workflows.get(mode);
  if (!wf) throw new Error(`Unknown workflow UI mode: ${mode}`);
  return wf;
}

export function getAllWorkflowUIs(): WorkflowUI[] {
  return [...workflows.values()];
}
