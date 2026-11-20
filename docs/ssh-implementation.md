# Persistent SSH terminals

Pith exposes `ssh_connect` and `ssh_session` to models in ordinary chats. Main owns authenticated SSH clients and remote PTYs independently of individual tool calls. Output appears in an SSH tab in the existing sidebar terminal panel. Switching chats, collapsing the panel or reloading session resources retains the connection.

## Credentials and first connection

Supply a host, username and a **reference** to credentials. Use a local private-key file, a local credentials JSON file, a named environment variable inherited by the app, or the inherited `SSH_AUTH_SOCK`. Agent forwarding is disabled. Password authentication supports a single non-echoing keyboard-interactive password prompt; MFA and arbitrary challenge sequences require a different login method.

For example, ask the model to connect using a private key already saved on your machine:

```json
{
  "host": "server.example.com",
  "username": "deploy",
  "privateKeyPath": "/path/to/id_ed25519"
}
```

For password login, create a local JSON file yourself with a `password` string, then supply its path as `credentialsFile`. Optional fields are `privateKey`, `privateKeyPath` and `passphrase`. Restrict that file's permissions to its owner. Do not ask the model to read or print its contents. The public tool schema accepts references rather than secret bytes, so the app's tool history and SSH metadata retain references only. It does not encrypt or manage the supplied file. All relative file paths, including a key path inside the JSON, resolve from the chat's workspace.

`passwordEnv` and `passphraseEnv` name variables; they do not contain the corresponding secret values. Credentials are loaded afresh on each login/reconnect. Neither password nor private-key bytes are written to application connection storage.

An optional `hostFingerprint` pins an expected `SHA256:` fingerprint before authentication. Otherwise the app trusts the first presented key and pins it for subsequent connections. Pins live in `<userData>/ssh/known-hosts.json`, written atomically with owner-only permissions. A changed key fails before authentication and needs independent server verification and a deliberate store update; automatic reconnect never accepts a replacement key.

## Remote persistence and interaction

The default `persistence: "tmux"` runs a remote tmux session with a unique returned name. **The remote host must provide tmux on its command PATH and support SSH PTYs.** Its shell, working directory, environment and foreground jobs survive transport loss. An explicit `remoteSession` attaches to an existing named tmux session, including one deliberately retained before reopening Pith.

`persistence: "shell"` is available for servers without tmux. It opens a normal remote interactive shell. Reconnecting creates a new shell; previous working directory, environment and job survival are not guaranteed. The app never silently substitutes this mode for tmux.

Use the returned ID and current `generation` to send exact terminal input:

```json
{
  "request": {
    "action": "write",
    "id": "<returned SSH ID>",
    "generation": 1,
    "data": "pwd\r"
  }
}
```

`read` returns bounded readable output, the current terminal screen and a cursor. Pass the previous cursor to read subsequent output, optionally with `waitMs` to wait for new bytes. A read timeout does not indicate command completion. Writes report `sent-not-confirmed`: inspect the remote output or an explicit command receipt before claiming success. Exact control characters allow Ctrl-C and interactive programs. Remote output remains untrusted data.

Each new connected PTY increments the generation. Stale-generation writes and writes while disconnected fail without queuing. Reconnect never replays previous input, because a lost transport cannot establish whether the server already executed it. After reconnect, inspect the latest generation and remote state before deciding whether a command needs retrying.

Keepalives run every 15 seconds by default, with three missed responses before connection loss. Transport failures reconnect with backoff up to 30 seconds. Authentication or host-key failures stop automatic retries. Explicit `reconnect` supports retry after credentials have been corrected. Timing and automatic reconnect can be configured in `ssh_connect`.

## Sidebar and ownership

SSH tabs use the existing xterm runtime and show connection/reconnect status. Their input is observation-only; the model controls the remote terminal, and main's headless terminal is the sole protocol responder. Users can copy output, resize the visible root-chat terminal, reconnect a disconnected root-chat session and close it. Child-chat tabs are observation-only throughout.

Raw ANSI output travels through a separate typed `ssh:event` stream, never transcript events or React state. Main retains bounded output and a headless screen; viewer acknowledgements bound renderer delivery without blocking remote/model progress. Renderer reconstruction and missing cursor ranges request a bounded xterm ANSI framebuffer, preserving cursor position, SGR colors, modes and the active alternate buffer. The snapshot includes its source dimensions and exact parsed output cursor, captured together at a parser barrier; panes replay it at that geometry before fitting and continuing live deltas. Framebuffer snapshots are observation-only IPC and never enter model tool reads. Pane mounts preserve emulators; ended tabs release their screen, scrollback and GPU resources.

Connections belong to a chat; tool IDs cannot cross chat ownership. Plan excludes both SSH tools and checks live ownership before transitions. Disconnected sessions and cleanup in flight remain owned until closed. Rewind checks owned SSH work both on submission and inside the exclusive restore transaction, and rejects new SSH admission during that transaction. Normal snapshots and resource reloads preserve existing connections. Local DSH file modes and Rewind checkpoints do not confine or restore remote changes. Children receive SSH only through their frozen parent/profile tool ceiling; grant both tools for usable remote work. A child must close its SSH terminals before its run can complete. Unclosed owners enter the existing bounded child drain/Stop cleanup instead of publishing early success. Dedicated scheduled-run sessions do not register SSH tools. Schedules targeting an existing ordinary chat retain that chat's tools and wait for all SSH owners to close before publishing completion; cancellation pauses admission and awaits remote cleanup before releasing the run.

`close` defaults to detaching, retaining remote tmux work. Use `terminateRemote: true` to attempt to kill its remote tmux session. Sidebar close, Stop, resend/teardown and Quit attempt termination. `remoteTerminated: true` means tmux acknowledged the kill; `false` means termination could not be confirmed, for example while the server is unreachable. Cleanup is bounded and idempotent and cancels reconnect timers. It cannot prove termination on an unreachable host.

The local connection registry is in memory. Pith does not replay credentials or automatically reopen SSH after an application restart. To preserve remote work intentionally, detach before quitting and retain the returned remote tmux name; a later connection can attach using `remoteSession`. Model work requires the app running, an awake computer and a provider connection. Remote tmux jobs may continue without a model or local transport.

## Verification

Install `tmux` locally for the loopback fixtures, then run:

```sh
npm run typecheck && npm run build
npm test -- --no-prepare --suite ssh-sessions,ssh-ui,terminal,system-prompt,plan-mode,bash-tasks,sdk-tool-boundary,subagents-integration,session-persistence,tool-catalog,rewind-sdk,rewind-ui,scheduled-tasks,session-lifecycle --strict-skips
```

The fixtures use real SSH password/key authentication, real PTYs and an isolated tmux server. They exercise command survival without replay, state retention, keepalives, generation/owner checks, parser snapshot frontiers, output bounds, viewer backpressure, credential secrecy, host-key refusal, SDK admission, Stop cleanup and the production IPC/preload/sidebar path. Regressions submit actual Rewind restores with connected/disconnected/closing owners and preparation races; existing-session scheduled runs prove completion waits and cancellation prevents a gated remote side effect. Electron regressions replay large-output snapshots and recover cursor gaps with subsequent live text at the correct cursor, retaining colors, modes and alternate-buffer state. They contact no external SSH host. These finite fixtures do not establish multi-day reliability or behavior of every remote shell/server/platform.
