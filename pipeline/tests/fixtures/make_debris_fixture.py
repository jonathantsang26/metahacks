"""Writes debris_inventory_sample.csv beside this file: a small stratified sample of USGS's
runoff-generated postfire debris-flow inventory (Graber et al. 2026, doi:10.5066/P1R9VXC4, CC0),
so the debris-flow tests run without pipeline/work/ (README.md here).

Rows are copied verbatim, with every column, in the inventory's order. The sample is fixed by SEED:
  * for each fire in FIRES (each chosen for a code path in step 14), its MAX_GROUPS largest
    fire-storm groups with both outcomes and ONE_OUTCOME_GROUPS of its groups with one outcome,
    drawn at random; from each group up to PER_OUTCOME debris flows and PER_OUTCOME non-flows of
    its usable records (s14.usable), drawn at random
  * up to UNUSABLE records per fire that s14.usable drops, so the filters have work to do

Run from pipeline/: uv run python tests/fixtures/make_debris_fixture.py [USGS_RG_PFDF_Inventory_v1.csv]
(default: work/debris_flow/USGS_RG_PFDF_Inventory_v1.csv, which step 14 downloads)
"""

from __future__ import annotations

import csv
import io
import random
import sys
from collections import defaultdict
from pathlib import Path

PIPELINE = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PIPELINE))

from steps.s14_debris_models import INVENTORY_CSV, STALEY_2016, usable  # noqa: E402

OUT = Path(__file__).with_name("debris_inventory_sample.csv")
SEED = 0
MAX_GROUPS = 3
ONE_OUTCOME_GROUPS = 2
PER_OUTCOME = 6
UNUSABLE = 2

FIRES = {
    ("Station", "2009"): "Staley et al. (2016) records; step 14's held-out analogue for Eaton",
    ("Coal Seam", "2002"): "Staley et al. (2016) records, many without PeakI15",
    ("Schultz", "2010"): "mostly Staley et al. (2016), with storms soon after the fire",
    ("Thomas", "2017"): "one storm 37 days after ignition, as soon as the Risk tab's scenario",
    ("Buzzard", "2018"): "many small storms (Graber 2023)",
    ("Ferguson", "2018"): "many small storms (Graber 2023)",
    ("Pinal", "2017"): "many small storms (Graber 2023)",
    ("Tadpole", "2020"): "many small storms (Graber 2024)",
    ("East Troublesome", "2020"): "new in this version of the inventory; some without HM23",
    ("Calwood", "2020"): "no debris flow at all, so left out of per-fire ROC AUC",
}


def sample(raw: list[dict]) -> list[dict]:
    rng = random.Random(SEED)
    kept = {r["UniqueObservationID"] for r in usable(raw)[0]}
    order = {r["UniqueObservationID"]: i for i, r in enumerate(raw)}
    picked = []
    for fire in FIRES:
        rows = [r for r in raw if (r["FireName"], r["FireYear"]) == fire]
        groups = defaultdict(list)
        for r in rows:
            if r["UniqueObservationID"] in kept:
                groups[r["StormStart"]].append(r)
        both = sorted((s for s, g in groups.items() if 0 < sum(r["Response"] == "1" for r in g) < len(g)),
                      key=lambda s: (-len(groups[s]), s))[:MAX_GROUPS]
        one = sorted(s for s in groups if s not in both and all(r["Response"] == groups[s][0]["Response"] for r in groups[s]))
        for s in both + rng.sample(one, min(ONE_OUTCOME_GROUPS, len(one))):
            for outcome in ("1", "0"):
                g = [r for r in groups[s] if r["Response"] == outcome]
                picked += rng.sample(g, min(PER_OUTCOME, len(g)))
        dropped = [r for r in rows if r["UniqueObservationID"] not in kept]
        picked += rng.sample(dropped, min(UNUSABLE, len(dropped)))
    return sorted(picked, key=lambda r: order[r["UniqueObservationID"]])


def main() -> None:
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else PIPELINE / "work" / "debris_flow" / INVENTORY_CSV
    text = src.read_text(encoding="utf-8-sig")
    header = next(csv.reader(io.StringIO(text)))
    rows = sample(list(csv.DictReader(io.StringIO(text))))
    with OUT.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=header, lineterminator="\n")
        w.writeheader()
        w.writerows(rows)
    ok = usable(rows)[0]
    print(f"wrote {OUT.name}: {len(rows)} records from {len({r['FireName'] for r in rows})} fires "
          f"({sum(r['Response'] == '1' for r in rows)} debris flows), {len(ok)} usable "
          f"({sum(r['PreviousUSGSInventory'] == STALEY_2016 for r in ok)} of them from {STALEY_2016})")


if __name__ == "__main__":
    main()
