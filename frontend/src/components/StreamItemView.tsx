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
        <div class="tl-item">
          <div class="tl-icon tl-icon-accent"><BotIcon /></div>
          <div class="tl-body">
            <div class="tl-label">Assistant</div>
            <div
              class="markdown-body"
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
        <div class="tl-item">
          <div class={`tl-icon ${statusCls}`}><TerminalIcon /></div>
          <div class="tl-body">
            <div class="tl-label">
              Command
              {exitCode != null && (
                <span class={`tl-badge ${failed ? "tl-badge-danger" : "tl-badge-success"}`}>
                  exit {exitCode}
                </span>
              )}
              {item.status && <span class="tl-badge">{item.status}</span>}
            </div>
            <pre class="tl-code">{item.command || ""}</pre>
            {item.aggregated_output && (
              <details class="tl-details" open>
                <summary>Output</summary>
                <pre class="tl-output">{item.aggregated_output}</pre>
              </details>
            )}
          </div>
        </div>
      );
    }

    case "file_change":
      return (
        <div class="tl-item">
          <div class="tl-icon tl-icon-info"><FileCodeIcon /></div>
          <div class="tl-body">
            <div class="tl-label">
              File Changes
              {item.status && (
                <span class={`tl-badge ${item.status === "failed" ? "tl-badge-danger" : "tl-badge-success"}`}>
                  {item.status}
                </span>
              )}
            </div>
            <div class="tl-file-list">
              {(item.changes || []).map((c, i) => (
                <span key={i} class="tl-path">
                  <span class={`tl-badge tl-badge-${c.kind === "delete" ? "danger" : c.kind === "add" ? "success" : "info"}`}>
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
        <div class="tl-item tl-item-muted">
          <div class="tl-icon tl-icon-muted"><BrainIcon /></div>
          <div class="tl-body">
            <details class="tl-details">
              <summary class="tl-label">Reasoning</summary>
              <div
                class="markdown-body markdown-body-muted"
                dangerouslySetInnerHTML={{ __html: renderMarkdown(item.text) }}
              />
            </details>
          </div>
        </div>
      );

    case "todo_list":
      return (
        <div class="tl-item">
          <div class="tl-icon tl-icon-accent"><ChecklistIcon /></div>
          <div class="tl-body">
            <div class="tl-label">Todo List</div>
            <ul class="tl-checklist">
              {(item.items || []).map((entry, i) => (
                <li key={i} class={entry.completed ? "is-done" : ""}>
                  <span class="tl-check">
                    {entry.completed
                      ? <CheckIcon />
                      : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /></svg>
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
        <div class="tl-item">
          <div class={`tl-icon ${mcpCls}`}><WrenchIcon /></div>
          <div class="tl-body">
            <div class="tl-label">
              {item.server || "mcp"}<span class="tl-dot">.</span>{item.tool || "?"}
              {item.status && <span class="tl-badge">{item.status}</span>}
            </div>
            {args != null && (
              <details class="tl-details">
                <summary>Arguments</summary>
                <pre class="tl-output">
                  {typeof args === "string" ? args : JSON.stringify(args, null, 2)}
                </pre>
              </details>
            )}
            {result != null && (
              <details class="tl-details">
                <summary>Result</summary>
                <pre class="tl-output">
                  {typeof result === "string" ? result : JSON.stringify(result, null, 2)}
                </pre>
              </details>
            )}
            {errMsg && <div class="tl-error-msg">{errMsg}</div>}
          </div>
        </div>
      );
    }

    case "web_search":
      return (
        <div class="tl-item">
          <div class="tl-icon tl-icon-info"><SearchIcon /></div>
          <div class="tl-body">
            <div class="tl-label">Web Search</div>
            <div class="tl-query">{item.query || ""}</div>
          </div>
        </div>
      );

    case "error":
      return (
        <div class="tl-item">
          <div class="tl-icon tl-icon-danger"><AlertIcon /></div>
          <div class="tl-body">
            <div class="tl-label">Error</div>
            <div class="tl-error-msg">{item.message || ""}</div>
          </div>
        </div>
      );

    default: {
      const unknown = item as { type?: string };
      return (
        <div class="tl-item">
          <div class="tl-icon tl-icon-muted"><DotIcon /></div>
          <div class="tl-body">
            <div class="tl-label">{unknown.type || "unknown"}</div>
            <pre class="tl-output">{JSON.stringify(item, null, 2)}</pre>
          </div>
        </div>
      );
    }
  }
}
