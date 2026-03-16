export function formatDate(value: string | null | undefined): string {
  if (!value) return "\u2014";
  const d = new Date(value);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function formatRelative(value: string | null | undefined): string {
  if (!value) return "";
  const seconds = Math.floor((Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export function formatStatus(value: string | null | undefined): string {
  return (value ?? "").replace(/-/g, " ");
}

export function normalizeMode(value: string | null | undefined): "repeated" | "generated" | "ranked" {
  if (value === "generated" || value === "task-generator") return "generated";
  if (value === "ranked" || value === "reviewed") return "ranked";
  return "repeated";
}

export function formatModeLabel(value: string | null | undefined): string {
  const mode = normalizeMode(value);
  return mode.charAt(0).toUpperCase() + mode.slice(1);
}

export function formatReasoningEffortLabel(value: string | null | undefined): string {
  if (value === "xhigh") return "XHigh";
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : "Default";
}
