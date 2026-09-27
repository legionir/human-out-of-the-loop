# STATE.md — Integration & Correctness Audit (human-out-of-the-loop) — COMPLETE

## Counters (verify with counts.sh)
- files.tsv: 525 (28 T1 DONE at required depth; rest tier-scoped)
- entrypoints.tsv: 65 → DONE 61, NA 4
- workflows.tsv: 60 DONE
- entities: 5 DONE (audit/entities/ENT-0001-0005.md)
- boundaries.tsv: 10 DONE
- findings: F-0001..F-0011 processed in P8 (5 standalone kept, 6 merged into SEC-001 family, 2 POSSIBLE)
- unknowns.md: 4 (UNKNOWN-0001..0004)
- searches.log: 20 logged commands

## Phase status
P0 PASSED / P1 PASSED / P2 PASSED (baseline BLOCKED recorded + static compensation) / P3 PASSED / P4 PASSED / P5 PASSED / P6a PASSED / P6b PASSED / P7 PASSED / P8 PASSED / P9 PASSED (gate G: repeat found 0 new) / P10 COMPLETE.

## Final verdict (REPORT.md §2)
SUBSTANTIALLY VERIFIED WITH OPEN ITEMS

## NEXT ACTION
None — audit complete. If session resumes: read audit/REPORT.md; optional follow-ups are the remediation items in REPORT.md §6 (code changes are OUT OF SCOPE of this read-only audit).
