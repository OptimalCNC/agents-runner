import { useAppStore } from "../state/store.js";
import { Toast } from "./Toast.js";

export function ToastContainer() {
  const toasts = useAppStore((s) => s.toasts);
  return (
    <div className="toast-container">
      {toasts.map((t) => (
        <Toast key={t.id} toast={t} />
      ))}
    </div>
  );
}
