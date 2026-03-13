import { formatStatus } from "../utils/format.js";

interface Props {
  status: string;
}

export function StatusPill({ status }: Props) {
  return (
    <span className={`pill pill-${status}`}>
      {status === "running" && <span className="spinner" />}
      {formatStatus(status)}
    </span>
  );
}
