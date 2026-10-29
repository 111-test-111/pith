# Debug fixtures

[scripts/debug-fixtures/](../scripts/debug-fixtures/) contains JavaScript, Python, Go and native samples for DAP checks. Missing adapters must report SKIP rather than a runtime pass. See [debug implementation](debug-implementation.md) for ownership and access rules.

## Native settlement replay

`dap-comparison/` contains an open-addressed receipt-index failure fixture:

- `base/` retains the defect: lookup stops at a retired slot, allowing a retried transfer to post twice. Test failure is expected.
- `with-dap/` and `without-dap/` are independent repairs of the same defect. Both probe past retired slots and stop only at never-occupied slots; each includes `index_test.c`.

Clang is required. Run `bash test.sh` in a fixture directory to compile and check three deterministic seeds in order. `base/` stops at its first expected failure; the repaired variants finish the replays and index regression. These are samples rather than application code or a debugger performance benchmark. `npm run clean` removes generated `ledger`, `index_test` and dSYM files.

Application verification:

```sh
node scripts/check-debug-actions.mjs
node scripts/check-debug-protocol.mjs
node scripts/check-debug-native.mjs
# Build before UI checks
npm run build
node scripts/check-debug-ui.mjs
node scripts/check-debug-native-ui.mjs
```
