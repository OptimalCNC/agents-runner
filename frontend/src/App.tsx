import { Navbar } from "./components/Navbar.js";
import { Sidebar } from "./components/Sidebar.js";
import { BatchDetail } from "./components/BatchDetail.js";
import { ToastContainer } from "./components/ToastContainer.js";
import { NewBatchDrawer } from "./dialogs/NewBatchDrawer.js";
import { DeleteBatchDialog } from "./dialogs/DeleteBatchDialog.js";

export function App() {
  return (
    <>
      <Navbar />
      <div class="app-layout">
        <Sidebar />
        <main class="main-content" id="mainContent">
          <BatchDetail />
        </main>
      </div>
      <NewBatchDrawer />
      <DeleteBatchDialog />
      <ToastContainer />
    </>
  );
}
