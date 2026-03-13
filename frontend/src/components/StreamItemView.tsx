import type { StreamItem } from "../types.js";
import { renderMarkdown } from "../utils/markdown.js";
import {
  BotIcon,
  TerminalIcon,
  FileCodeIcon,
  BrainIcon,
  ChecklistIcon,
  WrenchIcon,
  SearchIcon,
  AlertIcon,
  DotIcon,
  CheckIcon,
} from "../icons.js";

interface Props {
  item: StreamItem;
}

export function StreamItemView({ item }: Props) {
  switch (item.type) {
    case "agent_message":
      return (
        <div className="tl-item">
          <div className="tl-icon tl-icon-accent"><BotIcon /></div>
          <div className="tl-body">
            <div className="tl-label">Assistant</div>
            <div
              className="markdown-body"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(item.text) }}
            />
          </div>
        </div>
      );

    case "command_execution": {
      const exitCode = item.exit_code as number | undefined;
      const failed = item.status === "failed" || (exitCode != null && exitCode !== 0);
      const statusCls = failed ? "tl-icon-danger" : item.status === "in_progress" ? "tl-icon-muted" : "tl-icon-success";
      return (
        <div className="tl-item">
          <div className={`tl-icon ${statusCls}`}><TerminalIcon /></div>
          <div className="tl-body">
            <div className="tl-label">
              Command
              {exitCode != null && (
                <span className={`tl-badge ${failed ? "tl-badge-danger" : "tl-badge-success"}`}>
                  exit {exitCode}
                </span>
              )}
              {item.status && <span className="tl-badge">{item.status}</span>}
            </div>
            <pre className="tl-code">{item.command || ""}</pre>
            {item.aggregated_output && (
              <details className="tl-details" open>
                <summary>Output</summary>
                <pre className="tl-output">{item.aggregated_output}</pre>
              </details>
            )}
          </div>
        </div>
      );
    }

    case "file_change":
      return (
        <div className="tl-item">
          <div className="tl-icon tl-icon-info"><FileCodeIcon /></div>
          <div className="tl-body">
            <div className="tl-label">
              File Changes
              {item.status && (
                <span className={`tl-badge ${item.status === "failed" ? "tl-badge-danger" : "tl-badge-success"}`}>
                  {item.status}
                </span>
              )}
            </div>
            <div className="tl-file-list">
              {(item.changes || []).map((c, i) => (
                <span key={i} className="tl-path">
                  <span className={`tl-badge tl-badge-${c.kind === "delete" ? "danger" : c.kind === "add" ? "success" : "info"}`}>
                    {c.kind || "update"}
                  </span>
                  {" "}{c.path}
                </span>
              ))}
            </div>
          </div>
        </div>
      );

    case "reasoning":
      return (
        <div className="tl-item tl-item-muted">
          <div className="tl-icon tl-icon-muted"><BrainIcon /></div>
          <div className="tl-body">
            <details className="tl-details">
              <summary className="tl-label">Reasoning</summary>
              <div
                className="markdown-body markdown-body-muted"
                dangerouslySetInnerHTML={{ __html: renderMarkdown(item.text) }}
              />
            </details>
          </div>
        </div>
      );

    case "todo_list":
      return (
        <div className="tl-item">
          <div className="tl-icon tl-icon-accent"><ChecklistIcon /></div>
          <div className="tl-body">
            <div className="tl-label">Todo List</div>
            <ul className="tl-checklist">
              {(item.items || []).map((entry, i) => (
                <li key={i} className={entry.completed ? "is-done" : ""}>
                  <span className="tl-check">
                    {entry.completed
                      ? <CheckIcon />
                      : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /></svg>
                    }
                  </span>
                  {String((entry as { text?: string }).text ?? "")}
                </li>
              ))}
            </ul>
          </div>
        </div>
      );

    case "mcp_tool_call": {
      const mcpFailed = item.status === "failed" || Boolean(item.error);
      const mcpCls = mcpFailed ? "tl-icon-danger" : item.status === "in_progress" ? "tl-icon-muted" : "tl-icon-info";
      const args = item.arguments;
      const result = item.result;
      const errVal = item.error;
      const errMsg = errVal
        ? typeof errVal === "string"
          ? errVal
          : (errVal as { message?: string }).message || JSON.stringify(errVal)
        : null;
      return (
        <div className="tl-item">
          <div className={`tl-icon ${mcpCls}`}><WrenchIcon /></div>
          <div className="tl-body">
            <div className="tl-label">
              {item.server || "mcp"}<span className="tl-dot">.</span>{item.tool || "?"}
              {item.status && <span className="tl-badge">{item.status}</span>}
            </div>
            {args != null && (
              <details className="tl-details">
                <summary>Arguments</summary>
                <pre className="tl-output">
                  {typeof args === "string" ? args : JSON.stringify(args, null, 2)}
                </pre>
              </details>
            )}
            {result != null && (
              <details className="tl-details">
                <summary>Result</summary>
                <pre className="tl-output">
                  {typeof result === "string" ? result : JSON.stringify(result, null, 2)}
                </pre>
              </details>
            )}
            {errMsg && <div className="tl-error-msg">{errMsg}</div>}
          </div>
        </div>
      );
    }

    case "web_search":
      return (
        <div className="tl-item">
          <div className="tl-icon tl-icon-info"><SearchIcon /></div>
          <div className="tl-body">
            <div className="tl-label">Web Search</div>
            <div className="tl-query">{item.query || ""}</div>
          </div>
        </div>
      );

    case "error":
      return (
        <div className="tl-item">
          <div className="tl-icon tl-icon-danger"><AlertIcon /></div>
          <div className="tl-body">
            <div className="tl-label">Error</div>
            <div className="tl-error-msg">{item.message || ""}</div>
          </div>
        </div>
      );

    default: {
      const unknown = item as { type?: string };
      return (
        <div className="tl-item">
          <div className="tl-icon tl-icon-muted"><DotIcon /></div>
          <div className="tl-body">
            <div className="tl-label">{unknown.type || "unknown"}</div>
            <pre className="tl-output">{JSON.stringify(item, null, 2)}</pre>
          </div>
        </div>
      );
    }
  }
}
