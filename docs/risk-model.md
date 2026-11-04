# Per-area fire risk: a prototype, tested across fires

**Status: prototype.** Not wired into the app. Code: [`pipeline/steps/s17_risk_model.py`](../pipeline/steps/s17_risk_model.py), [`pipeline/ember/risk_nn.py`](../pipeline/ember/risk_nn.py). Outputs: `web/public/data/<fire>/risk/`. Background papers: [related-work.md](related-work.md).

## The question

Under each fire's own January 2025 Santa Ana winds, which ~95 m cells were most likely to burn, and which homes sat in them? Every score below for one fire comes from a model that never saw that fire's burn. Each fire is the other's only training set.

## What was built

- **Simulated fires (Monte Carlo burn probability, `physics_mc`).** 1,000 fires per area, each started at a random burnable cell and burned for 12 hours with the step 11 spread model in the real HRRR wind. Burn probability is the share of runs that reach a cell, as in the US Forest Service's FSim. It never sees the real burn.
- **Per-cell features.**
  - Fuel class.
  - Slope, and ridge vs valley (topographic position).
  - How far upslope points along the wind.
  - Mean wind and peak gust over the 24 hours after the reported start.
  - Vegetation and built-up share within 500 m, and distance to wildland.
- **Learned models.**
  - A random forest.
  - A small neural net (MLP).
  - The same MLP with **attention over 24 neighbouring cells** at about 95, 190 and 380 m. Each neighbour edge also carries its distance, how far upwind it is and how far downslope.
  - The attention model is written in plain numpy with hand-derived gradients, which a finite-difference test checks.
- **Ways of training.**
  - On the other fire's real burn (`*_real`).
  - On the other fire's simulated burn probability only (`attn_sim`, simulated-to-real).
  - On the real burn with burn probability as an extra feature (`attn_hybrid`).

Fuel and soil moisture are not inputs. They change day to day but barely across one fire's area at the available resolution, so two fires can't teach a model about them. `risk_model.json` records gridMET's dryness for each fire's start day as context:
- Eaton: ERC 88, 100-h fuel moisture 5.3%.
- Palisades: ERC 55, 100-h fuel moisture 9.6%.

## Results

ROC AUC over burnable cells. 0.5 is chance. The ranges are 95% intervals from resampling 1 km blocks. "Edge band" covers only cells within 1 km of the real burn's edge: given that the fire got close, did the model pick the right side of the line?

| Variant | Eaton (trained on Palisades) | Eaton, edge band | Palisades (trained on Eaton) | Palisades, edge band |
|---|---|---|---|---|
| Vegetation share (no training) | 0.64 (0.59–0.70) | 0.66 | 0.56 (0.51–0.60) | 0.45 |
| **Simulated burn probability** (no training) | **0.89 (0.86–0.93)** | **0.72** | 0.35 (0.29–0.40) | 0.50 |
| Random forest, real labels | 0.68 | 0.62 | 0.48 | 0.51 |
| MLP, real labels | 0.76 | 0.69 | 0.27 | 0.33 |
| Attention, real labels | 0.75 | **0.72** | 0.35 | 0.37 |
| **Attention, simulated labels only** | 0.76 (0.72–0.81) | 0.68 | 0.43 (0.37–0.49) | 0.45 |
| Attention, hybrid | 0.67 | 0.61 | 0.37 | 0.45 |

**Eaton works.** The simulated burn probability alone ranks the real burn well (AUC 0.89). The attention model trained only on Palisades simulations reaches 0.76 without ever seeing a real burn label. Among the 11,150 exposed homes inspected at Eaton, that model's risk separates destroyed from surviving homes (AUC 0.69): 32% were destroyed in its lowest-risk third vs 69% in its highest.

**Palisades does not.** Everything is at or below chance, and that is a finding about the label, not just the model. The Palisades area includes a large stretch of Santa Monica Mountains wildland west and north of the burn. The physics rates it just as hazardous, and the fire never got there. One fire's footprint shows where that fire went, which is not the same as where fire is likely. A model trained on Palisades' footprint learns "wildland didn't burn" and carries that to Eaton, which is why the real-label and hybrid models trail the simulated-only one there.

**Attention did not learn "look upwind".** On Eaton the simulated-label model puts slightly more weight on downwind neighbours (0.056) than upwind ones (0.030); uniform would be 0.042. It weights the farthest ring most (42% of the weight across 33% of the neighbours). Attention matches the plain MLP on all cells and leads it in Eaton's edge band (0.72 vs 0.69). With two fires, that gap is within noise.

**Homes:** being closer to wildland did *not* go with destruction among exposed homes (AUC 0.43 Eaton, 0.33 Palisades). Both were urban conflagrations: once inside the neighbourhood, fire spread home to home, as Knapp et al. (2021) found in Paradise.

## Choices made after seeing results (disclosed)

- **The planned map was `attn_hybrid`, fixed before scoring.** It scored worst on Eaton, because it learned from Palisades to use burn probability backwards. The map (`risk/risk_map.png`) now shows simulated burn probability in R and `attn_sim` in G, the two variants that use no real burn labels. That choice was made after seeing the scores. `risk_model.json` records it.
- **The edge-band evaluation and block-bootstrap intervals were added after the first run.** That run showed the Palisades problem.

## What would make it real

1. **Labels from fire history, not one fire.** CAL FIRE's FRAP perimeters (about a century of fires) give each cell's fire frequency, which is a direct target for "where fire is likely". It would also test the "burns about every 100 years" baseline. This sandbox can't reach the ArcGIS service; the step would fetch it the way step 05 fetches NIFC perimeters.
2. **More fires.** With two, every cross-fire number has one degree of freedom. Twenty Southern California fires would let fuel moisture and soil moisture (ERA5-Land, gridMET) enter as features, since they vary across fires even though they don't vary within one.
3. **Ignition likelihood.** Roads, power lines and population density decide where fires start (Syphard et al. 2007). Right now every burnable cell is equally likely to ignite.

## Run it

```bash
cd pipeline
uv run python -m steps.s17_risk_model        # both fires, about 4 minutes, offline
uv run pytest -q tests/test_risk_nn.py tests/test_s17_risk_model.py
```

## Companion: how often the debris-flow design storms come

[`steps/s16_rain_frequency.py`](../pipeline/steps/s16_rain_frequency.py) turns NOAA Atlas 14 into a yearly chance for each USGS design storm (I15 = 16–40 mm/h) and writes `rain_frequency.json`. At both fires every design storm is roughly a one-year storm or more frequent:
- **I15 = 40 mm/h:** ARI 1.05 y at Eaton (62% a year) and 1.23 y at Palisades (56%).
- **I15 = 24 mm/h:** extrapolated below Atlas 14's 1-year floor, about 86% a year at Eaton.

`annual_chance(table, "15-min", mm_h)` lets the Risk tab turn any segment's threshold into a chance per year. It is not wired in.
