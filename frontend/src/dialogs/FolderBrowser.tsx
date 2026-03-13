import { useEffect, useRef } from "react";
import { useAppStore } from "../state/store.js";
import { apiBrowseFs } from "../state/api.js";
import { ChevronLeftIcon } from "../icons.js";

interface Props {
  title: string;
  onSelect: (path: string) => void;
}

async function browsePath(path: string) {
  const payload = await apiBrowseFs(path);
  useAppStore.setState((s) => ({
    browserState: {
      ...s.browserState,
      currentPath: payload.path,
      parentPath: payload.parentPath,
      directories: payload.directories,
    },
  }));
}

export async function openBrowser(target: "project" | "worktree", initialPath: string) {
  useAppStore.setState({
    browserState: {
      target,
      currentPath: "",
      parentPath: null,
      directories: [],
    },
    browserDialogOpen: true,
  });
  await browsePath(initialPath || useAppStore.getState().config?.homeDirectory || "");
}

export function FolderBrowser({ title, onSelect }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const state = useAppStore((s) => s.browserState);
  const isOpen = useAppStore((s) => s.browserDialogOpen);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (isOpen && !dialog.open) {
      dialog.showModal();
    } else if (!isOpen && dialog.open) {
      dialog.close();
    }
  }, [isOpen]);

  function handleClose() {
    useAppStore.setState({ browserDialogOpen: false });
  }

  function handleSelect() {
    if (state.currentPath) {
      onSelect(state.currentPath);
    }
    useAppStore.setState({ browserDialogOpen: false });
  }

  return (
    <dialog ref={dialogRef} className="dialog" onClose={handleClose}>
      <form method="dialog" className="dialog-shell">
        <div className="dialog-header">
          <h3>{title}</h3>
          <button className="btn-icon" type="submit" aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="dialog-toolbar">
          <button
            className="btn btn-ghost btn-sm"
            type="button"
            disabled={!state.parentPath}
            onClick={() => state.parentPath && browsePath(state.parentPath)}
          >
            <ChevronLeftIcon />
            Up
          </button>
          <code className="browser-path">{state.currentPath}</code>
          <button className="btn btn-primary btn-sm" type="button" onClick={handleSelect}>
            Select
          </button>
        </div>
        <div className="browser-list">
          {state.directories.length === 0 ? (
            <div className="empty-state"><p className="empty-title">No child folders</p></div>
          ) : (
            state.directories.map((entry) => (
              <button
                key={entry.path}
                className="browser-entry"
                type="button"
                onClick={() => browsePath(entry.path)}
              >
                {entry.name}
              </button>
            ))
          )}
        </div>
      </form>
    </dialog>
  );
}
