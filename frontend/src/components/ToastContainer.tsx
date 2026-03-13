import { toasts } from "../state/store.js";
import { Toast } from "./Toast.js";

export function ToastContainer() {
  return (
    <div class="toast-container">
      {toasts.value.map((t) => (
        <Toast key={t.id} toast={t} />
      ))}
    </div>
  );
}
