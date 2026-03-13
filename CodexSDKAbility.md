# Codex SDK Ability Notes

## What we verified

We verified that when Codex SDK runs through non-interactive `codex exec`, approval does not show up as an interactive approval request in the streamed JSON events.

In our tests, a write attempted under `read-only` sandboxing was simply denied and returned to the model, and the recorded session context showed `approval_policy: "never"` even when we tried to pass `on-request`.

## Simple prompts to reproduce

A reader can ask a coding agent to run tests like these:

- "Create a tiny Codex SDK script that starts a thread in `read-only` mode with `approvalPolicy: \"on-request\"`, asks Codex to append one line to a file, streams all events, and then inspect the saved Codex session log to see what approval policy was actually recorded."
- "Run raw `codex exec --json` in `read-only` mode, ask Codex to append one line to a file using shell redirection instead of `apply_patch`, then inspect the session log and final message to see whether approval was requested or whether the write was just denied."

## Evidence from local runs

We inspected the local Codex session logs saved under `~/.codex/sessions/`. Those files are local runtime artifacts and are not intended to be committed.

Two runs were checked:

- An SDK-backed non-interactive run that asked Codex to modify a file through `apply_patch` while the thread was configured as `read-only`.
- A raw `codex exec --json` run that asked Codex to append one line through shell redirection while running in `read-only`.

Those local session files revealed:

- In both runs, the recorded turn context showed the effective approval policy as `never`.
- In the SDK-style run, the attempted patch operations were rejected by approval settings rather than turning into an interactive approval request.
- In the raw `exec` run, the shell write was denied by the sandbox and the model reported that approvals were disabled.

## Practical conclusion

For non-interactive SDK threads, `approvalPolicy` does not appear to produce a rich approval-request handshake in the event stream. In practice, the run behaves like `never`: the tool call is denied by the sandbox and the denial is returned to the model.

The interactive approval UX appears to belong to the full terminal UI path instead. During a TTY run of the top-level `codex` CLI, we saw interactive prompts, which is consistent with approvals being handled in the interactive client rather than the SDK JSON stream.

## If you need richer control

If you need rich control over Codex, especially around authentication, conversation history, approvals, and streamed agent events, use the official Codex App Server:

- https://developers.openai.com/codex/app-server

The official App Server docs describe it as a deeper integration point and include approval-related messages such as approval request / approved / rejected flows.
