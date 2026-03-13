import { useEffect, useRef } from "preact/hooks";
import { browserState, browserDialogOpen, config } from "../state/store.js";
import { apiBrowseFs } from "../state/api.js";
import { ChevronLeftIcon } from "../icons.js";

interface Props {
  title: string;
  onSelect: (path: string) => void;
}

async function browsePath(path: string) {
  const payload = await apiBrowseFs(path);
  browserState.value = {
    ...browserState.value,
    currentPath: payload.path,
    parentPath: payload.parentPath,
    directories: payload.directories,
  };
}

export async function openBrowser(target: "project" | "worktree", initialPath: string) {
  browserState.value = {
    target,
    currentPath: "",
    parentPath: null,
    directories: [],
  };
  browserDialogOpen.value = true;
  await browsePath(initialPath || config.value?.homeDirectory || "");
}

export function FolderBrowser({ title, onSelect }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const state = browserState.value;
  const isOpen = browserDialogOpen.value;

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
    browserDialogOpen.value = false;
  }

  function handleSelect() {
    if (state.currentPath) {
      onSelect(state.currentPath);
    }
    browserDialogOpen.value = false;
  }

  return (
    <dialog ref={dialogRef} class="dialog" onClose={handleClose}>
      <form method="dialog" class="dialog-shell">
        <div class="dialog-header">
          <h3>{title}</h3>
          <button class="btn-icon" type="submit" aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div class="dialog-toolbar">
          <button
            class="btn btn-ghost btn-sm"
            type="button"
            disabled={!state.parentPath}
            onClick={() => state.parentPath && browsePath(state.parentPath)}
          >
            <ChevronLeftIcon />
            Up
          </button>
          <code class="browser-path">{state.currentPath}</code>
          <button class="btn btn-primary btn-sm" type="button" onClick={handleSelect}>
            Select
          </button>
        </div>
        <div class="browser-list">
          {state.directories.length === 0 ? (
            <div class="empty-state"><p class="empty-title">No child folders</p></div>
          ) : (
            state.directories.map((entry) => (
              <button
                key={entry.path}
                class="browser-entry"
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
