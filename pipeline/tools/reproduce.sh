#!/usr/bin/env bash
# Reruns the documented offline evals and records what they produced, so the reproduction claims
# in README.md can be checked without rerunning them:
#   make eval FIRE=<fire>   real hold-out, compared field by field with the committed eval/ignition_holdout.json
#   make eval QUICK=1       recomputes the first synthetic cases and compares them with eval/ignition_synthetic.json
# Writes docs/reproduction/<fire>/ (the rerun's files) and docs/reproduction/log.md (commands, wall times, results).
# Run from pipeline/: tools/reproduce.sh [fire ...]   (default: eaton palisades)
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="$(cd .. && pwd)/docs/reproduction"
FIRES=("$@")
[ $# -eq 0 ] && FIRES=(eaton palisades)
mkdir -p "$OUT"
LOG="$OUT/log.md"
{
  echo "# Reproduction log"
  echo
  echo "Written by \`pipeline/tools/reproduce.sh\` at commit \`$(git rev-parse --short HEAD)\` on $(date -u '+%Y-%m-%d %H:%M UTC'), $(sysctl -n hw.ncpu 2>/dev/null || nproc) CPUs."
  [[ "$OUT" == *" "* ]] && echo "The checkout path contains spaces, so this also checks that EVAL_DIR is quoted."
  echo
} > "$LOG"

compare() {  # committed rerun -> prints IDENTICAL or the differing fields
  uv run python - "$1" "$2" <<'EOF'
import json, sys
a, b = (json.load(open(p)) for p in sys.argv[1:3])
def diff(x, y, path=""):
    if isinstance(x, dict) and isinstance(y, dict):
        for k in sorted(set(x) | set(y)):
            yield from diff(x.get(k), y.get(k), f"{path}.{k}")
    elif isinstance(x, list) and isinstance(y, list) and len(x) == len(y):
        for i, (u, v) in enumerate(zip(x, y)):
            yield from diff(u, v, f"{path}[{i}]")
    elif x != y:
        yield f"{path}: committed {x!r} vs rerun {y!r}"
d = list(diff(a, b))
print("IDENTICAL" if not d else "DIFFERENT\n" + "\n".join(d[:40]))
EOF
}

run() {  # dir, make args...
  local dir="$1"; shift
  mkdir -p "$dir"
  local t0=$SECONDS
  make eval "$@" EVAL_DIR="$dir" > "$dir/make.log" 2>&1 || { tail -20 "$dir/make.log"; exit 1; }
  rm -f "$dir/make.log"  # it holds absolute local paths
  echo "- \`make eval $*\`: exit 0, $(( (SECONDS - t0) / 60 )) min $(( (SECONDS - t0) % 60 )) s" >> "$LOG"
}

for fire in "${FIRES[@]}"; do
  dir="$OUT/$fire"
  echo "## $fire" >> "$LOG"
  echo >> "$LOG"
  run "$dir/holdout" FIRE="$fire"
  echo "- hold-out vs the committed \`web/public/data/$fire/eval/ignition_holdout.json\`: $(compare "../web/public/data/$fire/eval/ignition_holdout.json" "$dir/holdout/ignition_holdout.json" | head -1)" >> "$LOG"
  run "$dir/quick" QUICK=1 FIRE="$fire"
  echo "- synthetic check (\`docs/reproduction/$fire/quick/ignition_check.json\`): $(uv run python -c "import json,sys; d=json.load(open(sys.argv[1])); print(f\"{d['cases_checked']} cases, identical to the committed ones: {d['identical']}\")" "$dir/quick/ignition_check.json")" >> "$LOG"
  # Keep the comparison inputs small: the rerun's hold-out and check files, not the copied synthetic set.
  rm -f "$dir/holdout/ignition_synthetic.json" "$dir/quick/ignition_synthetic.json"
  echo >> "$LOG"
done
cat "$LOG"
