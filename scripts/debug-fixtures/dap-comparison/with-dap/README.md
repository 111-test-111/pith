# Settlement replay incident

A small native settlement service replays retryable transfers through a dispatch queue and a bounded receipt index. The linear reference book computes the expected balances independently. Receipt retention is a rolling three-epoch window; a transfer retried while its receipt is retained must not post twice.

Run `bash test.sh` to compile a debug-symbol binary and replay three production-like deterministic seeds. At least one run currently reports a settlement divergence. The printed epoch is a checkpoint, not necessarily the first bad transfer.

Find the underlying defect and make all three replays pass. Preserve the rolling receipt window and the open-addressed index (do not bypass the index, silence the check, or hard-code a seed). A concise explanation of the first faulty runtime state and a regression test are expected.
