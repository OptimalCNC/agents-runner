import { useEffect, useRef } from "react";
import { CheckCircleIcon, XCircleIcon, InfoIcon } from "../icons.js";
import { useAppStore } from "../state/store.js";
import type { Toast as ToastType } from "../state/store.js";

interface Props {
  toast: ToastType;
}

export function Toast({ toast }: Props) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const elRef = useRef<HTMLDivElement>(null);

  function dismiss() {
    if (!elRef.current) return;
    elRef.current.classList.add("is-leaving");
    elRef.current.addEventListener("animationend", () => useAppStore.getState().removeToast(toast.id), { once: true });
  }

  useEffect(() => {
    timerRef.current = setTimeout(dismiss, 4000);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const Icon = toast.type === "success" ? CheckCircleIcon : toast.type === "error" ? XCircleIcon : InfoIcon;

  return (
    <div ref={elRef} className={`toast toast-${toast.type}`} onClick={dismiss}>
      <div className="toast-icon">
        <Icon size={18} />
      </div>
      <div className="toast-body">
        <div className="toast-title">{toast.title}</div>
        {toast.message && <div className="toast-message">{toast.message}</div>}
      </div>
    </div>
  );
}
