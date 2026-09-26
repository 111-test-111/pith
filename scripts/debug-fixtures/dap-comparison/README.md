# DAP vs. no-debugger fault-finding exercise

`base/` is the untouched failure fixture. `with-dap/` and `without-dap/` started as byte-identical copies. Both agents were dispatched independently with the same incident description and source access, restricted to one copy. The DAP group uses the `general-purpose` profile and the actual LLDB DAP tool; the other uses `implementer` and may inspect source, compile, run tests, and instrument code, but must not use a debugger of any kind. Neither may read the other copy. Both may make a minimal fix and add a regression test. The incident is a rolling-window settlement replay with dispatch buffering and an open-addressed receipt index; the independent reference book checks final balances at each epoch.

Reproduce: `cd base && bash test.sh` (the initial seed fails at epoch 3, exit 1). The `base/` directory is intentionally left broken. After the agents finish, run `bash test.sh` separately in both other directories. These are *two solutions to the same bug*, not two changes to merge.

This is a qualitative A/B workflow test, not proof that a bug is mathematically impossible to find without a debugger. The observed outcomes, independent checks, and limitations are recorded in [RESULTS.md](RESULTS.md). Prior unrelated modifications in the surrounding repository are not part of the exercise.
