import type { BatchMode } from "../../types";
import { generatedWorkflow } from "./generated";
import { rankedWorkflow } from "./ranked";
import { repeatedWorkflow } from "./repeated";
import type { WorkflowDefinition } from "./types";

const workflows = new Map<BatchMode, WorkflowDefinition>([
  ["repeated", repeatedWorkflow],
  ["generated", generatedWorkflow],
  ["ranked", rankedWorkflow],
]);

export function getWorkflow(mode: BatchMode): WorkflowDefinition {
  const workflow = workflows.get(mode);
  if (!workflow) {
    throw new Error(`Unknown workflow mode: ${mode}`);
  }
  return workflow;
}
