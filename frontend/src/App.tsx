import { Navbar } from "./components/Navbar.js";
import { SettingsView } from "./components/SettingsView.js";
import { Sidebar } from "./components/Sidebar.js";
import { BatchDetail } from "./components/BatchDetail.js";
import { ToastContainer } from "./components/ToastContainer.js";
import { NewBatchDrawer } from "./dialogs/NewBatchDrawer.js";
import { DeleteBatchDialog } from "./dialogs/DeleteBatchDialog.js";
import { useAppStore } from "./state/store.js";

export function App() {
  const activeView = useAppStore((state) => state.activeView);

  return (
    <>
      <Navbar />
      <div className={`app-layout${activeView === "settings" ? " is-settings" : ""}`}>
        {activeView === "batches" && <Sidebar />}
        <main className={`main-content${activeView === "settings" ? " main-content-settings" : ""}`} id="mainContent">
          {activeView === "settings" ? <SettingsView /> : <BatchDetail />}
        </main>
      </div>
      <NewBatchDrawer />
      <DeleteBatchDialog />
      <ToastContainer />
    </>
  );
}
