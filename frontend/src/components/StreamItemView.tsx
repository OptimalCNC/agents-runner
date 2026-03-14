import type { ReactNode } from "react";

import type { StreamItem } from "../types.js";
import { renderMarkdown } from "../utils/markdown.js";
import {
  TerminalIcon,
  FileCodeIcon,
  BrainIcon,
  ChecklistIcon,
  WrenchIcon,
  SearchIcon,
  AlertIcon,
  CheckIcon,
  ChevronRightIcon,
} from "../icons.js";

interface Props {
  item: StreamItem;
  grouped?: boolean;
}

export type CollapsibleCategory =
  | "default"
  | "bash"
  | "edit"
  | "search"
  | "todo"
  | "tool"
  | "thinking"
  | "danger";

export interface StreamItemGroupMeta {
  label: string;
  singular: string;
  plural: string;
  category: CollapsibleCategory;
  icon: ReactNode;
}

interface CollapsibleEntryProps {
  icon: ReactNode;
  label: string;
  title: string;
  category?: CollapsibleCategory;
  badges?: string[];
  defaultOpen?: boolean;
  children?: ReactNode;
}

function summarizeText(value: unknown, limit: number = 140): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) {
    return "";
  }
  return text.length > limit ? `${text.slice(0, limit).trim()}...` : text;
}

function formatJson(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

export function getStreamItemGroupMeta(item: StreamItem): StreamItemGroupMeta | null {
  switch (item.type) {
    case "command_execution":
      return {
        label: "Bash",
        singular: "command",
        plural: "commands",
        category: item.status === "failed" || (item.exit_code != null && item.exit_code !== 0) ? "danger" : "bash",
        icon: <TerminalIcon size={13} />,
      };
    case "file_change":
      return {
        label: "Edit",
        singular: "change",
        plural: "changes",
        category: "edit",
        icon: <FileCodeIcon size={13} />,
      };
    case "todo_list":
      return {
        label: "Todo",
        singular: "list",
        plural: "lists",
        category: "todo",
        icon: <ChecklistIcon size={13} />,
      };
    case "mcp_tool_call":
      return {
        label: "Tool",
        singular: "call",
        plural: "calls",
        category: item.status === "failed" || Boolean(item.error) ? "danger" : "tool",
        icon: <WrenchIcon size={13} />,
      };
    case "web_search":
      return {
        label: "Search",
        singular: "request",
        plural: "requests",
        category: "search",
        icon: <SearchIcon size={13} />,
      };
    default:
      return null;
  }
}

function CollapsibleEntry({
  icon,
  label,
  title,
  category = "default",
  badges = [],
  defaultOpen = false,
  children,
}: CollapsibleEntryProps) {
  const summary = (
    <div className="tx-collapsible-summary">
      <span className="tx-collapsible-chevron">
        <ChevronRightIcon size={13} />
      </span>
      <span className="tx-collapsible-icon">{icon}</span>
      <span className="tx-collapsible-copy">
        <span className="tx-collapsible-label">{label}</span>
        <span className="tx-collapsible-title">{title}</span>
      </span>
      {badges.length > 0 && (
        <span className="tx-collapsible-badges">
          {badges.filter(Boolean).map((badge) => (
            <span key={badge} className="tx-collapsible-badge">{badge}</span>
          ))}
        </span>
      )}
    </div>
  );

  if (!children) {
    return <div className={`tx-collapsible tx-collapsible-${category} is-static`}>{summary}</div>;
  }

  return (
    <details className={`tx-collapsible tx-collapsible-${category}`} open={defaultOpen}>
      <summary>{summary}</summary>
      <div className="tx-collapsible-body">{children}</div>
    </details>
  );
}

export function StreamItemView({ item, grouped = false }: Props) {
  const groupedClassName = grouped ? " is-grouped-child" : "";

  switch (item.type) {
    case "agent_message":
      return (
        <div className="tx-assistant-message">
          <div
            className="markdown-body"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(item.text) }}
          />
        </div>
      );

    case "reasoning":
      return (
        <CollapsibleEntry
          icon={<BrainIcon size={13} />}
          label="Reasoning"
          title={summarizeText(item.text, 180) || "Hidden by default."}
          category="thinking"
        >
          <div
            className="markdown-body markdown-body-muted"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(item.text) }}
          />
        </CollapsibleEntry>
      );

    case "command_execution": {
      const exitCode = item.exit_code as number | undefined;
      const failed = item.status === "failed" || (exitCode != null && exitCode !== 0);
      const badges = [
        item.status || "",
        exitCode != null ? `exit ${exitCode}` : "",
      ].filter(Boolean);

      return (
        <div className={groupedClassName}>
          <CollapsibleEntry
          icon={<TerminalIcon size={13} />}
          label="Bash"
          title={summarizeText(item.command, 110) || "Shell command"}
          category={failed ? "danger" : "bash"}
          badges={badges}
        >
          <div className="tx-detail-group">
            <div className="tx-detail-label">Command</div>
            <pre className="tx-detail-code">{item.command || ""}</pre>
          </div>
          {item.aggregated_output && (
            <div className="tx-detail-group">
              <div className="tx-detail-label">Output</div>
              <pre className="tx-detail-code">{item.aggregated_output}</pre>
            </div>
          )}
          </CollapsibleEntry>
        </div>
      );
    }

    case "file_change": {
      const changes = item.changes || [];
      const summary = changes.length
        ? `${changes.length} file ${changes.length === 1 ? "change" : "changes"}`
        : "File updates";

      return (
        <div className={groupedClassName}>
          <CollapsibleEntry
          icon={<FileCodeIcon size={13} />}
          label="Edit"
          title={summary}
          category="edit"
          badges={item.status ? [item.status] : []}
        >
          <div className="tx-file-list">
            {changes.length ? changes.map((change, index) => (
              <div key={`${change.path}-${index}`} className="tx-file-row">
                <span className={`tx-file-kind tx-file-kind-${change.kind || "update"}`}>
                  {change.kind || "update"}
                </span>
                <span className="tx-file-path">{change.path}</span>
              </div>
            )) : (
              <div className="text-muted text-sm">No file changes recorded.</div>
            )}
          </div>
          </CollapsibleEntry>
        </div>
      );
    }

    case "todo_list": {
      const total = item.items?.length || 0;
      const done = (item.items || []).filter((entry) => entry.completed).length;

      return (
        <div className={groupedClassName}>
          <CollapsibleEntry
          icon={<ChecklistIcon size={13} />}
          label="Todo"
          title={`${done}/${total} completed`}
          category="todo"
        >
          <ul className="tx-checklist">
            {(item.items || []).map((entry, index) => (
              <li key={index} className={entry.completed ? "is-done" : ""}>
                <span className="tx-checklist-icon">
                  {entry.completed
                    ? <CheckIcon size={13} />
                    : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /></svg>
                  }
                </span>
                {String(entry.text ?? "")}
              </li>
            ))}
          </ul>
          </CollapsibleEntry>
        </div>
      );
    }

    case "mcp_tool_call": {
      const failed = item.status === "failed" || Boolean(item.error);
      const errorMessage = item.error
        ? typeof item.error === "string"
          ? item.error
          : item.error.message || JSON.stringify(item.error)
        : "";

      return (
        <div className={groupedClassName}>
          <CollapsibleEntry
          icon={<WrenchIcon size={13} />}
          label="Tool"
          title={`${item.server || "mcp"}.${item.tool || "unknown"}`}
          category={failed ? "danger" : "tool"}
          badges={item.status ? [item.status] : []}
        >
          {item.arguments != null && (
            <div className="tx-detail-group">
              <div className="tx-detail-label">Arguments</div>
              <pre className="tx-detail-code">{formatJson(item.arguments)}</pre>
            </div>
          )}
          {item.result != null && (
            <div className="tx-detail-group">
              <div className="tx-detail-label">Result</div>
              <pre className="tx-detail-code">{formatJson(item.result)}</pre>
            </div>
          )}
          {errorMessage && <div className="tx-inline-error">{errorMessage}</div>}
          </CollapsibleEntry>
        </div>
      );
    }

    case "web_search":
      return (
        <div className={groupedClassName}>
          <CollapsibleEntry
          icon={<SearchIcon size={13} />}
          label="Search"
          title={summarizeText(item.query, 160) || "Search request"}
          category="search"
        >
          <div className="tx-detail-group">
            <div className="tx-detail-label">Query</div>
            <div className="tx-detail-text">{item.query || ""}</div>
          </div>
          </CollapsibleEntry>
        </div>
      );

    case "error":
      return (
        <div className="tx-inline-error tx-inline-error-strong">
          <span className="tx-inline-error-icon"><AlertIcon size={14} /></span>
          <span>{item.message || ""}</span>
        </div>
      );

    default:
      return (
        <div className={groupedClassName}>
          <CollapsibleEntry
          icon={<AlertIcon size={13} />}
          label={(item as { type?: string }).type || "unknown"}
          title="Unsupported event payload"
          category="default"
        >
          <pre className="tx-detail-code">{JSON.stringify(item, null, 2)}</pre>
          </CollapsibleEntry>
        </div>
      );
  }
}
