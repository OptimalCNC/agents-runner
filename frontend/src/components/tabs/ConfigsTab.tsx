import { ChevronRightIcon } from "../../icons.js";
import type { CodexTurnConfig, Run, RunTurn } from "../../types.js";
import { formatDate } from "../../utils/format.js";

interface Props {
  run: Run;
}

interface ConfigEntry {
  turn: RunTurn;
  turnNumber: number;
}

interface DetailItem {
  label: string;
  value: string;
  mono?: boolean;
  multiline?: boolean;
}

function formatBoolean(value: boolean): string {
  return value ? "Enabled" : "Disabled";
}

function formatOptional(value: string | null | undefined, fallback: string = "Default"): string {
  const trimmed = String(value ?? "").trim();
  return trimmed || fallback;
}

function formatConfigValue(value: unknown): string {
  if (value == null) {
    return "None";
  }

  if (typeof value === "string") {
    return value.trim() || "Empty";
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (Array.isArray(value)) {
    return value.length > 0 ? value.map((entry) => formatConfigValue(entry)).join(", ") : "[]";
  }

  return JSON.stringify(value, null, 2);
}

function humanizeConfigKey(key: string): string {
  return key
    .split("_")
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

export function buildSessionDetails(config: CodexTurnConfig): DetailItem[] {
  const additionalDirectories = config.sessionConfig.additionalDirectories || [];
  const items: DetailItem[] = [
    { label: "Model", value: formatOptional(config.sessionConfig.model), mono: true },
    { label: "Sandbox", value: config.sessionConfig.sandboxMode, mono: true },
    { label: "Approval", value: config.sessionConfig.approvalPolicy, mono: true },
    { label: "Working Directory", value: config.sessionConfig.workingDirectory, mono: true },
    { label: "Network", value: formatBoolean(config.sessionConfig.networkAccessEnabled) },
    { label: "Web Search", value: formatBoolean(config.sessionConfig.webSearchEnabled) },
    { label: "Search Mode", value: config.sessionConfig.webSearchMode, mono: true },
    { label: "Reasoning", value: formatOptional(config.sessionConfig.modelReasoningEffort) },
  ];

  if (additionalDirectories.length > 0) {
    items.push({
      label: "Additional Directories",
      value: additionalDirectories.join("\n"),
      mono: true,
      multiline: true,
    });
  }

  return items;
}

function buildClientConfigDetails(config: CodexTurnConfig): DetailItem[] {
  return Object.entries(config.clientConfig)
    .filter(([key]) => key !== "developer_instructions")
    .map(([key, value]) => {
      const formattedValue = formatConfigValue(value);
      return {
        label: humanizeConfigKey(key),
        value: formattedValue,
        mono: typeof value !== "string" || key.includes("path") || key.includes("dir"),
        multiline: formattedValue.includes("\n") || formattedValue.length > 120,
      };
    });
}

function DetailGrid({ items }: { items: DetailItem[] }) {
  return (
    <div className="settings-detail-grid">
      {items.map((item) => (
        <div key={item.label} className="settings-detail-card">
          <div className="settings-detail-label">{item.label}</div>
          {item.multiline ? (
            <pre className={`code-block tx-config-block settings-detail-value${item.mono ? " mono" : ""}`}>{item.value}</pre>
          ) : (
            <div className={`settings-detail-value settings-break${item.mono ? " mono" : ""}`}>{item.value}</div>
          )}
        </div>
      ))}
    </div>
  );
}

function getConfigEntries(run: Run): ConfigEntry[] {
  return run.turns.flatMap((turn, index) => (
    turn.codexConfig ? [{ turn, turnNumber: index + 1 }] : []
  ));
}

export function ConfigsTab({ run }: Props) {
  const configEntries = getConfigEntries(run);

  if (configEntries.length === 0) {
    return <div className="run-logs-empty text-muted text-sm">No turn configs recorded yet.</div>;
  }

  return (
    <div className="run-logs-list">
      {configEntries.map(({ turn, turnNumber }) => {
        const config = turn.codexConfig!;
        const clientConfigDetails = buildClientConfigDetails(config);

        return (
          <details
            key={turn.id}
            className="tx-collapsible tx-collapsible-config"
            open={configEntries.length === 1}
          >
            <summary>
              <div className="tx-collapsible-summary">
                <span className="tx-collapsible-chevron">
                  <ChevronRightIcon size={13} />
                </span>
                <span className="tx-collapsible-copy">
                  <span className="tx-collapsible-label">Config</span>
                  <span className="tx-collapsible-title">Turn {turnNumber} launch settings</span>
                </span>
                <span className="tx-collapsible-badges">
                  <span className="tx-collapsible-badge">{config.launchMode}</span>
                  {config.developerPrompt && (
                    <span className="tx-collapsible-badge">developer prompt</span>
                  )}
                </span>
              </div>
            </summary>
            <div className="tx-collapsible-body">
              <div className="form-hint">
                Submitted {formatDate(turn.submittedAt)}
                {turn.startedAt ? ` · Started ${formatDate(turn.startedAt)}` : ""}
                {turn.completedAt ? ` · Completed ${formatDate(turn.completedAt)}` : ""}
              </div>

              <DetailGrid
                items={[
                  { label: "Launch Mode", value: config.launchMode || "Unknown" },
                  { label: "Resume Thread", value: formatOptional(config.resumeThreadId, "New thread"), mono: true },
                ]}
              />

              <div className="settings-subsection">
                <div className="settings-subsection-header">
                  <div>
                    <div className="settings-detail-label">Session Settings</div>
                    <div className="form-hint">The Codex runtime options used for this turn.</div>
                  </div>
                </div>
                <DetailGrid items={buildSessionDetails(config)} />
              </div>

              {config.developerPrompt && (
                <div className="settings-subsection">
                  <div className="settings-subsection-header">
                    <div>
                      <div className="settings-detail-label">Developer Prompt</div>
                      <div className="form-hint">Injected instructions sent alongside the turn.</div>
                    </div>
                  </div>
                  <pre className="code-block tx-config-block">{config.developerPrompt}</pre>
                </div>
              )}

              {clientConfigDetails.length > 0 && (
                <div className="settings-subsection">
                  <div className="settings-subsection-header">
                    <div>
                      <div className="settings-detail-label">Additional Client Config</div>
                      <div className="form-hint">Extra SDK client options captured for this turn.</div>
                    </div>
                  </div>
                  <DetailGrid items={clientConfigDetails} />
                </div>
              )}
            </div>
          </details>
        );
      })}
    </div>
  );
}
