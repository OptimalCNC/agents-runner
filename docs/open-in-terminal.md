# Open In Terminal

This guide explains how the native `Open Terminal` feature works and how to extend it with additional terminal launchers.

## Architecture

The feature is intentionally split across frontend and backend responsibilities:

- Frontend:
  - detects the browser platform in `frontend/src/utils/clientPlatform.ts`
  - decides whether the current config can launch a terminal in `frontend/src/utils/terminalLaunch.ts`
  - exposes the launcher preference in `frontend/src/components/SettingsView.tsx`
  - sends a launch request from `frontend/src/components/RunDetail.tsx`
- Backend:
  - persists the terminal preference in `src/lib/appSettings.ts`
  - exposes preference and launcher capability metadata through `src/server/appConfig.ts` and `/api/config`
  - validates launch requests in `src/server/routes/terminal.ts`
  - resolves launcher support and builds the spawn command in `src/lib/terminal.ts`

This split exists because the app is a standard local web app, not a desktop app. Browser JavaScript can decide which launcher should be used, but it cannot directly execute `wt.exe`, `wsl.exe`, or any other local process. The backend performs the one-time bootstrap by spawning the terminal process, then immediately drops ownership.

## Runtime Flow

The runtime path for `Open Terminal` is:

1. `RunDetail` picks the target directory from `run.workingDirectory ?? run.worktreePath`.
2. The frontend detects the browser platform and computes whether launching is currently supported.
3. Clicking `Open Terminal` calls `POST /api/terminal/launch` with:
   - `path`
   - `clientPlatform`
4. The terminal route validates that the path is absolute, exists, and is a directory.
5. `launchTerminal()` in `src/lib/terminal.ts`:
   - reads the saved terminal preference
   - resolves `auto` to a concrete launcher
   - builds the launcher command
   - spawns a detached child process with ignored stdio
   - calls `unref()` so Agents Runner does not retain ownership
6. The native terminal window opens and the user interacts with it directly outside the browser.

## Current Launcher Model

The current shared types live in:

- `src/types.ts`
- `frontend/src/types.ts`

Relevant types:

- `TerminalPreference`
- `TerminalLauncherId`
- `TerminalLauncherInfo`
- `ClientPlatform`

Current values:

- `TerminalPreference`: `auto`, `windows-terminal`
- `TerminalLauncherId`: `windows-terminal`

`auto` currently means:

- if the browser is on Windows and Windows Terminal is supported on the host, use Windows Terminal
- otherwise report the feature as unsupported

## Detached Lifetime

The backend must not manage terminal lifetime after launch.

That rule is implemented in `spawnDetachedProcess()` in `src/lib/terminal.ts`:

- `detached: true`
- `stdio: "ignore"`
- `child.unref()`

As a result:

- terminal windows stay open if Agents Runner exits
- batch cancellation does not affect launched terminals
- deleting a batch does not affect launched terminals
- every click opens a fresh terminal instance

This is intentional. `Open Terminal` is a native handoff, not a backend-owned terminal session.

## Adding A New Terminal Launcher

To add another terminal later, treat it as a new launcher entry, not a special case inside the route handler.

### 1. Extend the shared types

Update:

- `src/types.ts`
- `frontend/src/types.ts`

Add the new launcher id to:

- `TerminalLauncherId`
- `TerminalPreference` if it should be directly selectable by users

### 2. Add backend capability and command support

Update `src/lib/terminal.ts`:

- extend `TerminalHostInfo` if the new launcher needs additional host facts
- add a launcher-info builder similar to `getWindowsTerminalLauncherInfo()`
- include the launcher in `getTerminalLaunchers()`
- extend `resolveTerminalLauncher()` if `auto` should resolve to the new launcher in some environments
- add a command builder for the new launcher
- update `launchTerminal()` to dispatch to that builder

Keep command building in the terminal library, not in the HTTP route.

### 3. Surface it through config

`src/server/appConfig.ts` already returns launcher metadata from `getTerminalLaunchers()`.

If the new launcher only needs backend support, this metadata will flow automatically into `/api/config`. No route change should be necessary unless the launcher needs new request data.

### 4. Make it selectable in Settings

Update `frontend/src/components/SettingsView.tsx`:

- add a new option in the terminal preference `<select>`
- update any helper text if `auto` behavior changes

The availability display already comes from `config.terminal.launchers`, so support status should come from the backend rather than being recomputed in the component.

### 5. Update frontend launch resolution

Update `frontend/src/utils/terminalLaunch.ts`:

- teach `resolveTerminalLaunchState()` how to label and gate the new launcher
- update `auto` behavior if the default resolution changes

This file should stay focused on UI state, not process spawning.

### 6. Add tests

Backend tests:

- `src/lib/terminal.test.ts`
- `src/server/routes/terminal.test.ts`
- `src/server/appConfig.test.ts` if config metadata changes

Frontend tests:

- `frontend/test/terminalLaunch.test.ts`
- `frontend/test/clientPlatform.test.ts` if browser-platform handling changes

At minimum, cover:

- launcher support detection
- `auto` resolution
- command generation
- route validation
- disabled/enabled frontend state

## Practical Rules For Future Development

- Keep launcher definitions in `src/lib/terminal.ts`; do not spread process-spawn rules across routes or components.
- Keep browser detection in the frontend and host capability detection in the backend.
- Keep `/api/terminal/launch` as a fire-and-forget action. Do not attach process tracking unless the feature explicitly becomes a managed terminal session.
- Prefer adding new launchers as separate entries in the registry instead of adding more branching inside the Windows Terminal logic.
- If a future launcher requires a desktop integration, browser extension, or custom URI protocol, treat that as a different architecture from the current backend-bootstrap model.
