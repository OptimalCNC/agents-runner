import type { ComponentType } from "react";
import type { Batch, BatchMode, Run } from "../types.js";

export interface FormFieldsProps {
  prompt: string;
  setPrompt: (v: string) => void;
  taskPrompt: string;
  setTaskPrompt: (v: string) => void;
  reviewPrompt: string;
  setReviewPrompt: (v: string) => void;
  reviewCount: string;
  setReviewCount: (v: string) => void;
}

export interface RunsGridProps {
  batch: Batch;
  selectedRunId: string | null;
}

export interface RunCardExtras {
  tags?: Array<{ label: string; className?: string }>;
  scoreLabel?: string;
  rankLabel?: string;
}

export interface WorkflowUI {
  mode: BatchMode;
  label: string;
  Icon: ComponentType;

  // NewBatchDrawer
  getMaxConcurrency(runCount: number, reviewCount: number): number;
  getConcurrencyHint(limit: number): string;
  canSubmit(fields: { prompt: string; taskPrompt: string; reviewPrompt: string }): boolean;
  FormFields: ComponentType<FormFieldsProps>;

  // BatchDetail
  buildRunsSummaryLabel(batch: Batch): string;
  RunsGrid: ComponentType<RunsGridProps>;
  TasksSection: ComponentType<{ batch: Batch }> | null;

  // RunDetail
  isSessionReadOnly: boolean;
  showReviewTab(run: Run): boolean;

  // RunCard
  getRunCardExtras(run: Run): RunCardExtras | null;
}
