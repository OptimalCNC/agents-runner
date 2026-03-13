import { formatStatus } from "../utils/format.js";

interface Props {
  status: string;
}

export function StatusPill({ status }: Props) {
  return (
    <span class={`pill pill-${status}`}>
      {status === "running" && <span class="spinner" />}
      {formatStatus(status)}
    </span>
  );
}
