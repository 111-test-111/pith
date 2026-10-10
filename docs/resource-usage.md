# Resource usage

Settings → Resources is a read-only view of operating-system process counters
and filesystem metadata. The main service owns measurement; the preload exposes
typed DTOs from `src/shared/resources.ts`. The settings registry keeps the panel
mounted after its first visit, passing its active state so it can stop polling.

## Running resources

The visible panel requests a sample every two seconds after the previous request
finishes. Inactive panels and background windows stop requesting samples. One
main-owned sampler coalesces simultaneous callers across windows; an interval
longer than five seconds resets the baseline. The first sample provides memory
and process identities but leaves CPU unavailable until a second sample.

CPU uses differences of cumulative user/system CPU seconds divided by monotonic
elapsed time. One logical core is 100%; the secondary readout divides by the
logical core count to show the share of total machine capacity. Electron's own
process counters come from `app.getAppMetrics().cpu.cumulativeCPUUsage`; its
interval-dependent `percentCPUUsage` is deliberately ignored. PID plus creation
time identifies Electron processes. Native process identity identifies external
children, so PID reuse cannot subtract a previous process's CPU counters. A
process born within the interval contributes its actual lifetime CPU time.

The native census includes the main process's attached descendants, including
terminals, background commands, MCP servers and debug processes. It excludes
its own census helper and deduplicates Electron processes. macOS uses BSD `ps`
(CPU precision is centiseconds); Linux reads `/proc` cumulative clock ticks and
RSS for the selected tree; Windows uses `Win32_Process` cumulative 100 ns CPU
counters and working-set bytes through a bounded PowerShell/CIM query. Commands
run without a shell, with a deadline and bounded output. Processes reparented
after their owner exits are outside this tree. A snapshot describes observed
live processes, not CPU consumed by already exited processes between samples.

Memory is the sum of resident working sets, preferring the native census for a
consistent RSS basis. Electron's KiB values are converted to bytes as a fallback;
Linux can omit its memory object despite the SDK declarations. Shared resident
pages can appear in multiple processes. This is explicitly labelled as summed
resident memory, not exclusive physical memory or JS heap usage. Incomplete
native coverage suppresses totals and retains the measured process details.

## Disk data

An explicit scan visits the complete user-data and Pi-data trees, the configured
library archive, Chromium's session-data directory, and app log/crash-report
directories. All roots come from main-owned settings/runtime paths. Pi's data
is shared with its CLI and is labelled accordingly. Installation files, project
source files and exports/downloads outside these roots are outside the view.
The default internal workspace remains part of app data, never a project path.

The scan runs in a disposable ESM worker with bounded concurrent metadata reads.
Root realpaths avoid duplicate/overlapping traversals. `lstat` measures internal
symlinks themselves without following targets; directory paths are checked
again before traversal. Device/inode identities deduplicate hard links, with
stable category precedence for cross-category links. Unknown files are still
counted in Other. SQLite WAL/SHM/journal files are counted with their databases.

File size is the byte length of regular files and links. Allocated space is
filesystem-reported `st_blocks × 512`, including directories and links, on
macOS/Linux. Windows reports allocation as unavailable because Node's stat does
not expose a reliable allocation count there; it still reports exact file
lengths. Sparse files can have large logical lengths and small allocations.
Shared extents, compression and filesystem snapshots prevent treating these
allocated blocks as exclusive physical usage. Compact sizes use binary units;
exact byte counts appear alongside them.

Scans have start/end timestamps and are not atomic filesystem snapshots. Writers
continue normally. Unreadable or disappearing paths mark results partial and
report a bounded path list plus the complete issue count. Missing uncreated
roots do not imply a failed scan. Concurrent scan requests share a worker; a
failed refresh leaves the previous snapshot visible with an error. Quit stops
new requests and terminates the worker through the existing bounded cleanup.

## Verification

After typecheck/build, run:

```sh
npm test -- --no-prepare --suite resources,resources-ui,settings-tabs --strict-skips
```

The integration suite compares exact lengths and blocks with independent
filesystem fixtures, including sparse files, hard links, root overlap, symlink
cycles, permissions and refresh. It checks CPU identities/units and a real host
child process. The UI suite uses the built preload/worker and production resource
IPC in isolated Electron, checking live process coverage, external archives,
polling lifetimes, retained failure states and all three locales. Set
`PI_RESOURCES_SCREENSHOT_DIR` to retain a layout gallery. Adapter fixtures do not
claim execution on operating systems other than the host running the suite.
