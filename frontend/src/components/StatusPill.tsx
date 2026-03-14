import { formatStatusLabel, isActiveRunStatus } from "../utils/runStatus.js";

interface Props {
  status: string;
}

export function StatusPill({ status }: Props) {
  const pillClassName = `pill pill-${status.replace(/_/g, "-")}`;
  const showSpinner = isActiveRunStatus(status);

  return (
    <span className={pillClassName}>
      {showSpinner && <span className="spinner" />}
      {formatStatusLabel(status)}
    </span>
  );
}
