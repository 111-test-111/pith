# Windows development

This guide describes building the Electron client on Windows, including Windows
11 on ARM64 in a Parallels guest. Validate native dependencies, terminal and
sandbox behavior on the target machine before relying on them.
Build and install dependencies inside Windows so Electron, Node native modules
and build tools use the guest's architecture.

## Prerequisites

Install Node.js 22.19 or later (Node 24 for the test tools), npm and Git for
Windows. Git includes the Bash executable used by agent shell tools. Install the
[Microsoft Visual C++ Redistributable](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist)
matching the Node architecture. A missing runtime can prevent Rollup's native
module from loading even after `npm ci` succeeds.

Keep the checkout and `node_modules` on the guest's local NTFS disk, for example
`$env:USERPROFILE\source\pi-app`. A Parallels shared folder can transfer source
files; exclude host `node_modules`, `out`, `dist`, caches and local credentials.
Install the guest dependencies from `package-lock.json` with scripts enabled.

## Build and launch

From PowerShell in the Windows checkout:

```powershell
npm.cmd ci
node node_modules/electron/install.js
npm.cmd run typecheck
npm.cmd run build
npm.cmd run preview
```

The explicit Electron install downloads the guest binary when it is missing
and is a no-op when it is already installed.

`npm.cmd` avoids PowerShell's script-policy restriction on `npm.ps1` without
changing the user's execution policy. Use `npm.cmd run dev` for HMR. A portable
Node installation must be on the launcher's `PATH`, along with Git's `cmd` and
`bin` directories, so child processes and terminals inherit the same tools.

After launch, configure a provider in Settings. Windows keeps its own Pi
configuration under `%USERPROFILE%\.pi\agent` and application preferences under
`%APPDATA%\pi-app`.

## Parallels

The macOS Parallels CLI can list and start an existing guest:

```sh
prlctl list -a
prlctl start 'Windows 11'
```

Parallels Tools must be available before executing guest commands. Launch the
application in the logged-in user's desktop session with `prlctl exec
'Windows 11' --current-user`, or run the preview command from a Windows terminal.
For longer PowerShell commands, use a `.ps1` file accessible to the guest and
`powershell.exe -NoProfile -File <path>`; this also avoids nested command-line
quoting across macOS, Parallels and Windows.

Verify both the process and the visible application window. A successful
`prlctl exec` or a running Electron process alone does not prove that the
renderer initialized.

## Checks

After typecheck and build, select portable checks through the source-owned
catalog, for example:

```powershell
npm.cmd test -- --no-prepare --suite startup-session --suite window-chrome --strict-skips
npm.cmd test -- --no-prepare --suite test-runner
```

The runner infrastructure suite skips its POSIX process-group cases on Windows.
See [testing](testing.md) for platform and adapter coverage. POSIX-only fixtures
do not establish Windows runtime coverage.
