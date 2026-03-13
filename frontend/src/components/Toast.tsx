import { useEffect, useRef } from "preact/hooks";
import { CheckCircleIcon, XCircleIcon, InfoIcon } from "../icons.js";
import { removeToast } from "../state/store.js";
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
    elRef.current.addEventListener("animationend", () => removeToast(toast.id), { once: true });
  }

  useEffect(() => {
    timerRef.current = setTimeout(dismiss, 4000);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const Icon = toast.type === "success" ? CheckCircleIcon : toast.type === "error" ? XCircleIcon : InfoIcon;

  return (
    <div ref={elRef} class={`toast toast-${toast.type}`} onClick={dismiss}>
      <div class="toast-icon">
        <Icon size={18} />
      </div>
      <div class="toast-body">
        <div class="toast-title">{toast.title}</div>
        {toast.message && <div class="toast-message">{toast.message}</div>}
      </div>
    </div>
  );
}
