# Independent investigation results

This is a **qualitative trial, not evidence that the bug is practically impossible without debugging**. Two agents started from byte-identical source copies, independently located the same defect, and passed the same replay tests. The non-debugger group succeeded with temporary per-transfer instrumentation; DAP made the live probe chain and call path directly inspectable, but was not necessary in this trial.

| | DAP (`general-purpose`) | No debugger (`implementer`) |
| --- | --- | --- |
| Diagnosis | LLDB DAP launch, breakpoint, stack/scopes/variables/evaluate and execution control; found an epoch-3 retry of `tr-d096a4e4` behind a retired slot | Temporary per-transfer comparisons; found the same first duplicate posting, account 2 differing by +209 |
| Fix | `with-dap/index.c`: stop probing only at a never-occupied slot and match live slots | `without-dap/index.c`: same semantics |
| Targeted test | `with-dap/index_test.c`: finds a collision and checks lookup across a retired slot | `without-dap/index_test.c`: fixed colliding keys and tests retirement/reuse |
| Independent verification | 3 prescribed seeds plus seeds 1–100 pass | 3 prescribed seeds plus seeds 1–100 pass |

The untouched `base/` fails at epoch 3 for all three prescribed seeds and for 40/40 additional seeds tested. Compiling the DAP group's new index regression against `base/index.c` fails at the expected assertion (`index_test.c:43`, exit 134), proving it catches the original bug.

Independent DAP verification: the real `lldb-dap` adapter launched the base binary with symbols, stopped at the divergence in `ledger.c:160`, returned a `main` stack frame and `epoch=3`, and evaluated `actual.index.slots[168]` and `[170]`: the same receipt key `tr-d096a4e4` appeared twice (new epoch 3 and original epoch 1). A separate adapter doctor passed launch/breakpoint/stack/scopes/variables/evaluate; a real LLDB session check passed core dump inspection and session operations. Other adapters were unavailable and **not** counted as runtime passes.

Friction and limits: the DAP agent's first 32-turn run hit its limit after an initial wrong-working-directory attempt and produced no fix or final report; a resumed run completed it. In the independent DAP check, an LLDB conditional breakpoint using `strcmp(...)` was reported verified yet stopped on a different key; evaluating that condition showed an LLDB C-expression error (`strcmp` return type unknown without a cast). A subsequent variable-only condition did not hit before termination. An unconditional breakpoint at the divergence worked. Thus conditional expression behavior should be diagnosed separately rather than assumed from the `verified` flag. These extra turns and the different diagnostic techniques prevent a defensible speed comparison.

The two repairs are separate experiment outputs; do not merge both directories into the application. The case demonstrates DAP's direct runtime-state visibility, **not** that this particular bug is nearly impossible to solve without DAP. A stronger claim would require a harder, independently validated incident and repeated matched trials.
