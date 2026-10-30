"""Generate docs/RESULTS.md from the committed outputs, so every number in it is reproducible.

Reads, per fire: eval/ignition_synthetic.json, eval/ignition_holdout.json, ignition.json,
exposure_stats.json, weather_station.json, severity_stats.json, arrival_meta.json,
perimeters.geojson, aoi.json, and eval/analyst.json when it exists.

Run: uv run python -m tools.report   (or: make report)
"""

from __future__ import annotations

import json
from pathlib import Path

from ember.config import REPO_DIR, load_fire

FIRES = ["eaton", "palisades"]
OUT = REPO_DIR / "docs" / "RESULTS.md"


def read(fire, name):
    path = fire.out_dir / name
    return json.loads(path.read_text()) if path.exists() else None


def fmt_min(m: float) -> str:
    return f"{m / 60:.1f} h" if abs(m) >= 120 else f"{m:.0f} min"


def synthetic_section(fire) -> list[str]:
    syn = read(fire, "eval/ignition_synthetic.json")
    if not syn:
        return [f"*No synthetic benchmark for {fire.name} yet.*", ""]
    c = syn["config"]
    scenarios = [("all perimeters (as the app fits)", syn.get("summary_all_observations"), syn.get("calibration_all_observations")),
                 (f"first {c['holdout_first_n']} held out (stress test)", syn["summary"], syn.get("calibration"))]
    rows = [
        f"**{fire.name}**: {syn['summary']['n']} synthetic ignitions; observation delays after ignition "
        f"{', '.join(f'{x:g}' for x in c['schedule_h_after_ignition'])} h.",
        "",
        "| Metric | Fit on | Back-trace median | Back-trace p90 | Baseline median | Baseline p90 | Back-trace better |",
        "|---|---|---|---|---|---|---|",
    ]
    for label, s, _ in scenarios:
        if not s:
            continue
        d = s["distance_m"]
        rows.append(f"| Ignition location error | {label} | {d['backtrace']['median']:,.0f} m | {d['backtrace']['p90']:,.0f} m | "
                    f"{d['baseline_first_footprint_centroid']['median']:,.0f} m | {d['baseline_first_footprint_centroid']['p90']:,.0f} m | "
                    f"{s['backtrace_beats_baseline']['distance']:.0%} of cases |")
    for label, s, _ in scenarios:
        if not s:
            continue
        t = s["start_time_error_min"]
        rows.append(f"| Start-time error | {label} | {fmt_min(t['backtrace']['median'])} | {fmt_min(t['backtrace']['p90'])} | "
                    f"{fmt_min(t['baseline_area_backcast']['median'])} | {fmt_min(t['baseline_area_backcast']['p90'])} | "
                    f"{s['backtrace_beats_baseline']['time']:.0%} of cases |")
    rows += [
        "",
        f"Truth physics differs from the inverted model: {c['truth_perturbation']}. "
        "Location baseline = centroid of the first footprint the fit sees; time baseline = linear back-extrapolation of sqrt(area).",
        "",
    ]
    for label, _, cal in scenarios:
        rows += calibration_lines(cal, label)
    return rows


def calibration_lines(cal, label: str) -> list[str]:
    if not cal:
        return []
    t = cal["test_coverage"]
    reached = "" if cal["reached_on_calibration_half"] else " (the 90% target was not reached on the calibration half; this is the widest setting tried)"
    return [
        f"Uncertainty calibration, {label}: posterior temperature tau = {cal['tau_h']:g} h, chosen on the {cal['calibration_cases']} "
        f"even-numbered cases{reached}. On the {cal['test_cases']} odd-numbered cases it never saw, the 90% radius "
        f"(median {cal['median_test_r90_m']:,.0f} m) contains the true ignition in {t['distance']:.0%} of cases and the "
        f"90% start-time interval (median width {cal['median_test_t90_width_h']:g} h) contains the true start in {t['time']:.0%}.",
        "",
    ]


def holdout_section(fire) -> list[str]:
    h = read(fire, "eval/ignition_holdout.json")
    ign = read(fire, "ignition.json")
    if not h:
        return []
    e = h.get("errors", {})
    rows = [
        f"**{fire.name}**: fit on {len(h['fit_observations'])} perimeters from {h['fit_observations'][0]}; "
        f"held out {', '.join(x['t'] for x in h['held_out'])}.",
        "",
        "| | Back-trace | Baseline |",
        "|---|---|---|",
    ]
    est = h["estimate"]
    if e:
        yes = lambda b: "yes" if b else "no"
        rows += [
            f"| Distance to CAL FIRE's reported location | {e['backtrace_distance_m']:,.0f} m | {e['baseline_distance_m']:,.0f} m |",
            f"| Start time vs CAL FIRE's official start | {fmt_min(e['backtrace_time_error_min'])} | {fmt_min(e['baseline_time_error_min'])} |",
        ]
        if "reference_within_r90" in e:
            rows += [
                f"| Reported location inside the 90% radius ({est['r90_m']:,.0f} m) | {yes(e['reference_within_r90'])} | – |",
                f"| Official start inside the 90% interval ({est['t90'][0]} – {est['t90'][1]}) | {yes(e['reference_within_t90'])} | – |",
            ]
    rows += [f"| IoU with held-out perimeter {x['t']} | {x['iou']:.2f} | – |" for x in h["held_out"]]
    rows.append("")
    if "timing" in est:
        rows += [timing_line("Hold-out fit", est["timing"]), ""]
    if ign:
        rows.append(f"Full fit (all perimeters): estimate {ign['map']['lat']:.5f}, {ign['map']['lon']:.5f} at {ign['map']['t']}, "
                    f"spread-rate scale k = {ign['map']['k']}, 90% radius {ign.get('r90_m', 0):,.0f} m, "
                    f"90% start interval {' – '.join(ign.get('t90', []))}, {ign['candidates_evaluated']:,} candidates; "
                    f"modeled vs observed footprint IoU {', '.join(f'{v:.2f}' for v in ign['modeled_vs_observed_iou'])}.")
        if "timing" in ign:
            rows += ["", timing_line("Full fit", ign["timing"])]
        rows.append("")
    return rows


def timing_line(what: str, tm: dict) -> str:
    if tm["identifiable"]:
        return f"{what}: start time identifiable (90% interval {tm['interval90_width_h']:g} h wide)."
    return f"{what}: **start time not identifiable**: {'; '.join(tm['reasons'])}. The timeline omits the estimated start."


def exposure_section(fire) -> list[str]:
    st = read(fire, "exposure_stats.json")
    if not st:
        return []
    rows = [
        f"**{fire.name}**: {st['n']:,} exposed residences, {st['destroyed']:,} destroyed; strata split at the median gust "
        f"at arrival ({st['gust_split_mph']} mph) × distance to wildland.",
        "",
        "| Feature contrast | n | Mantel–Haenszel OR (95% CI) | Unknown on destroyed / surviving homes |",
        "|---|---|---|---|",
    ]
    for c in st["contrasts"]:
        ci = f"{c['or']:.2f} ({c['ci95'][0]:.2f}–{c['ci95'][1]:.2f})" if c["or"] else "n/a"
        u = c["unknown_rate"]
        rows.append(f"| {c['label']} | {c['n']:,} | {ci} | {u['destroyed']:.0%} / {u['surviving']:.0%} |")
    rows += ["", "OR < 1: the first group was destroyed less often than the second within the same exposure strata. "
             "Associations, not causal effects.", ""]
    return rows


def data_section(fire) -> list[str]:
    aoi, meta = read(fire, "aoi.json"), read(fire, "arrival_meta.json")
    ws, sev = read(fire, "weather_station.json"), read(fire, "severity_stats.json")
    per = read(fire, "perimeters.geojson")
    rows = [f"**{fire.name}**"]
    if per and meta:
        rows.append(f"- {len(per['features'])} timed perimeters kept; arrival raster burns {meta['burned_acres']:,.0f} acres "
                    f"vs CAL FIRE's official {aoi['official']['final_acres']:,.0f}.")
    if ws:
        c = ws["comparison"]
        rows.append(f"- Reanalysis vs {ws['station']} ({ws.get('name', '')}): hourly wind r = {c['wind_corr']:.2f}, "
                    f"bias {c['wind_bias_mph']:+.1f} mph; max gust {c['max_gust_reanalysis_mph']:.0f} mph (ERA5) vs "
                    f"{c['max_gust_station_mph']:.0f} mph (station).")
    if sev and "perimeter" in sev:
        p = sev["perimeter"]
        rows.append(f"- AVIRIS-3 dNBR covers {p['coverage']:.0%} of the final perimeter "
                    f"({p['covered_acres']:,.0f} of {p['area_acres']:,.0f} acres).")
    rows.append("")
    return rows


def analyst_section() -> list[str]:
    fire = load_fire("eaton")
    a = read(fire, "eval/analyst.json")
    if not a:
        return ["Not run yet: the 15-question analyst eval (`cd web && npm run eval:analyst`) needs `MODEL_API_KEY`. "
                "Its ground truth is computed from the data files (`npm run eval:analyst -- --truth`).", ""]
    return [f"```json\n{json.dumps(a.get('summary', a), indent=2)}\n```", ""]


def main() -> None:
    fires = [load_fire(f) for f in FIRES]
    lines = [
        "# Results",
        "",
        "Generated by `pipeline/tools/report.py` (`make report`) from the committed outputs in `web/public/data/`. "
        "Do not edit by hand.",
        "",
        "## Ignition back-trace: synthetic recovery benchmark",
        "",
    ]
    for f in fires:
        lines += synthetic_section(f)
    lines += ["## Ignition back-trace: real hold-out", "",
              "The model never sees the first two perimeters or CAL FIRE's reference. CAL FIRE's point is the "
              "reported incident location, not an investigated origin.", ""]
    for f in fires:
        lines += holdout_section(f)
    lines += ["## House-level construction associations", ""]
    for f in fires:
        lines += exposure_section(f)
    lines += ["## Data checks", ""]
    for f in fires:
        lines += data_section(f)
    lines += ["## Analyst eval", ""] + analyst_section()
    OUT.write_text("\n".join(lines).rstrip() + "\n")
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
