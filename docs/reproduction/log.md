# Reproduction log

Written by `pipeline/tools/reproduce.sh` at commit `67933f4` on 2026-10-31 04:14 UTC, 12 CPUs.
The checkout path contains spaces, so this also checks that EVAL_DIR is quoted.

## eaton

- `make eval FIRE=eaton`: exit 0, 4 min 23 s
- hold-out vs the committed `web/public/data/eaton/eval/ignition_holdout.json`: IDENTICAL
- `make eval QUICK=1 FIRE=eaton`: exit 0, 6 min 59 s
- synthetic check (`docs/reproduction/eaton/quick/ignition_check.json`): 2 cases, identical to the committed ones: True

## palisades

- `make eval FIRE=palisades`: exit 0, 11 min 37 s
- hold-out vs the committed `web/public/data/palisades/eval/ignition_holdout.json`: IDENTICAL
- `make eval QUICK=1 FIRE=palisades`: exit 0, 5 min 22 s
- synthetic check (`docs/reproduction/palisades/quick/ignition_check.json`): 2 cases, identical to the committed ones: True

