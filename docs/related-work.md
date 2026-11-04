# Related work

What this project builds on, grouped by the question each part answers. Every entry says what we take from it. Links go to the publisher's DOI or the agency page.

## Why these fires were so destructive: climate and fire weather

The January 2025 fires were driven by a wet-then-dry swing and a strong Santa Ana event. Our wind field (HRRR, step 07) and the dryness context in `weather.json` (gridMET ERC and fuel moisture) are the local view of what these studies describe at a regional scale.

1. **Barnes, C., et al. (2025).** *Climate change increased the likelihood of wildfire disaster in highly exposed Los Angeles area.* World Weather Attribution. [worldweatherattribution.org](https://www.worldweatherattribution.org/climate-change-increased-the-likelihood-of-wildfire-disaster-in-highly-exposed-los-angeles-area/)
   Rapid attribution study of the January 2025 fires. It finds the hot, dry, windy conditions behind them more likely in today's climate, and that the dry season now overlaps more with the Santa Ana season. It frames our scenario: the risk map in `risk/risk_model.json` is conditional on exactly this kind of event.

2. **Swain, D. L., et al. (2025).** *Increasing hydroclimatic whiplash can amplify wildfire risk in a warming climate.* Global Change Biology, 31, e70075. [doi:10.1111/gcb.70075](https://doi.org/10.1111/gcb.70075)
   Two very wet winters grew a large crop of grass and brush, and a record-dry start to the 2024–25 rainy season dried it out. This is the "fuel" half of the story, which our two-fire model cannot learn (see the risk model's caveats), so we cite it rather than claim it.

3. **Billmire, M., French, N. H. F., Loboda, T., Owen, R. C., & Tyner, M. (2014).** *Santa Ana winds and predictors of wildfire progression in southern California.* International Journal of Wildland Fire, 23(8), 1119–1129. [doi:10.1071/WF13046](https://doi.org/10.1071/WF13046) · [PMC8411922](https://pmc.ncbi.nlm.nih.gov/articles/PMC8411922/)
   Over 158 southern California fires (2001–2009), daily burned area was about 3.5–4.5 times larger on Santa Ana days. Relative humidity was the most consistent correlate, and gust and peak wind speed were strongly correlated with daily growth, above all on first days and Santa Ana days. This supports driving the spread model with the hourly HRRR wind field, not a single station.

4. **NASA Earth Observatory (2025).** *Fuel for California fires.* Not peer reviewed. [science.nasa.gov](https://science.nasa.gov/earth/earth-observatory/fuel-for-california-fires-153896/)
   Satellite view of the vegetation build-up before the fires. A plain-language companion to Swain et al.

5. **Abatzoglou, J. T., & Williams, A. P. (2016).** *Impact of anthropogenic climate change on wildfire across western US forests.* PNAS, 113(42), 11770–11775. [doi:10.1073/pnas.1607171113](https://doi.org/10.1073/pnas.1607171113)
   Long-run warming has dried fuels across the western US. It is background for why fuel dryness (ERC, 100-h fuel moisture) is recorded for each fire.

## Fire regimes: southern California shrublands burn by nature

These papers support the point that much of the region's fire is driven by the environment, not only by people. Chaparral regimes are wind-driven and fuel-age-tolerant, and suppression has not removed large fires.

6. **Keeley, J. E., Fotheringham, C. J., & Morais, M. (1999).** *Reexamining fire suppression impacts on brushland fire regimes.* Science, 284(5421), 1829–1832. [doi:10.1126/science.284.5421.1829](https://doi.org/10.1126/science.284.5421.1829)
   Across a century of records, large chaparral fires did not become rarer under suppression, unlike in many forests. Wind events, not old fuel, make them large.

7. **Keeley, J. E., & Fotheringham, C. J. (2001).** *Historic fire regime in southern California shrublands.* Conservation Biology, 15, 1536–1548. [doi:10.1046/j.1523-1739.2001.00097.x](https://doi.org/10.1046/j.1523-1739.2001.00097.x)
   The natural regime is infrequent, high-intensity crown fire in shrublands, at intervals of several decades to about a century. This is the "California burns about every 100 years" baseline.

8. **Syphard, A. D., Radeloff, V. C., Keeley, J. E., Hawbaker, T. J., Clayton, M. K., Stewart, S. I., & Hammer, R. B. (2007).** *Human influence on California fire regimes.* Ecological Applications, 17(5), 1388–1402. [doi:10.1890/06-1128.1](https://doi.org/10.1890/06-1128.1)
   The counterweight: in California, ignitions (and so fire frequency) track people, with fire most frequent at intermediate housing density. Our risk model does not model ignitions at all; every burnable cell is equally likely to ignite.

## Homes in the wrong places: the wildland–urban interface and structure loss

9. **Radeloff, V. C., et al. (2018).** *Rapid growth of the US wildland–urban interface raises wildfire risk.* PNAS, 115(13), 3314–3319. [doi:10.1073/pnas.1718850115](https://doi.org/10.1073/pnas.1718850115)
   The WUI was the fastest-growing land-use type in the US from 1990 to 2010. This frames the "urban development in the wrong areas" question. Our model's `built_frac_500m` and `log1p_dist_wildland_m` features describe where homes meet fuel.

10. **Syphard, A. D., & Keeley, J. E. (2019).** *Factors associated with structure loss in the 2013–2018 California wildfires.* Fire, 2(3), 49. [doi:10.3390/fire2030049](https://doi.org/10.3390/fire2030049)
    Uses CAL FIRE damage inspections (DINS), as our step 09b does. Construction features (vents, eaves, windows) and nearby structure density were associated with loss. Our odds ratios for vents and roofs follow this design, and adjust for exposure.

11. **Knapp, E. E., Valachovic, Y. S., Quarles, S. L., & Johnson, N. G. (2021).** *Housing arrangement and vegetation factors associated with single-family home survival in the 2018 Camp Fire, California.* Fire Ecology, 17, 25. [doi:10.1186/s42408-021-00117-0](https://doi.org/10.1186/s42408-021-00117-0)
    Distance to the nearest destroyed structure was a strong predictor of loss. Home-to-home spread is why the risk prototype finds that, among exposed homes, closeness to wildland does *not* predict destruction in these two urban fires.

## Fire spread and burn probability models

12. **Rothermel, R. C. (1972).** *A mathematical model for predicting fire spread in wildland fuels.* USDA Forest Service Research Paper INT-115.
    The wind and slope terms of `ember/spread.py` (the head-fire rate grows with a power of the wind and with tan² of the slope) are simplified from this model.

13. **Anderson, H. E. (1983).** *Predicting wind-driven wild land fire size and shape.* USDA Forest Service Research Paper INT-305.
    The length-to-breadth ratio that sets the spread ellipse in `ember/spread.py`.

14. **Finney, M. A., McHugh, C. W., Grenfell, I. C., Riley, K. L., & Short, K. C. (2011).** *A simulation of probabilistic wildfire risk components for the continental United States.* Stochastic Environmental Research and Risk Assessment, 25, 973–1000. [Treesearch](https://research.fs.usda.gov/treesearch/39312)
    FSim: burn probability as the share of many simulated fires that reach a cell. Step 17's `physics_mc` variant is a small version of this, with our spread model, the real HRRR winds and uniform ignitions.

15. **Huot, F., Hu, R. L., Goyal, N., Sankar, T., Ihme, M., & Chen, Y.-F. (2022).** *Next Day Wildfire Spread: A machine learning dataset to predict wildfire spreading from remote-sensing data.* IEEE Transactions on Geoscience and Remote Sensing. [arXiv:2112.02447](https://arxiv.org/abs/2112.02447)
    A widely used benchmark for learning fire spread from weather, terrain and vegetation rasters with neural networks. Our learned variants are much smaller, and we test them across fires rather than across random pixels, because neighbouring cells leak labels.

## Post-fire debris flows (the Risk tab)

16. **Staley, D. M., Negri, J. A., Kean, J. W., Laber, J. L., Tillery, A. C., & Youberg, A. M. (2017).** *Prediction of spatially explicit rainfall intensity–duration thresholds for post-fire debris-flow generation in the western United States.* Geomorphology, 278, 149–162. [doi:10.1016/j.geomorph.2016.10.019](https://doi.org/10.1016/j.geomorph.2016.10.019)
    The M1 logistic model used by USGS's hazard assessments, and so by steps 14–15. Its likelihoods are conditional on a storm's peak 15-minute intensity (I15).

17. **Cannon, S. H., Gartner, J. E., Wilson, R. C., Bowers, J. C., & Laber, J. L. (2008).** *Storm rainfall conditions for floods and debris flows from recently burned areas in southwestern Colorado and southern California.* Geomorphology, 96(3–4), 250–269. [doi:10.1016/j.geomorph.2007.03.019](https://doi.org/10.1016/j.geomorph.2007.03.019)
    Rainfall intensity–duration thresholds for post-fire debris flows in southern California. These are short, intense bursts, which is why step 16 works with 15-minute intensities.

18. **Gartner, J. E., Cannon, S. H., & Santi, P. M. (2014).** *Empirical models for predicting volumes of sediment deposited by debris flows and sediment-laden floods in the Transverse Ranges of southern California.* Engineering Geology, 176, 45–56. [doi:10.1016/j.enggeo.2014.04.008](https://doi.org/10.1016/j.enggeo.2014.04.008)
    The volume model USGS pairs with M1 in the Transverse Ranges, where both fires are.

19. **Kean, J. W., et al. (2019).** *Inundation, flow dynamics, and damage in the 9 January 2018 Montecito debris-flow event, California, USA: Opportunities and challenges for post-wildfire risk assessment.* Geosphere, 15(4), 1140–1163. [doi:10.1130/GES02048.1](https://doi.org/10.1130/GES02048.1)
    The Montecito disaster followed the Thomas Fire and killed 23 people. It is the reference case for why post-fire rain matters in this region: a short, intense burst of rain over a burn scar less than a month after the fire.

20. **NOAA (2011).** *NOAA Atlas 14, Volume 6: Precipitation-Frequency Atlas of the United States, California.* [PFDS](https://hdsc.nws.noaa.gov/pfds/)
    Source of step 16's return periods. At both fires, every USGS design storm (I15 = 16–40 mm/h) is about a one-year storm or more frequent (`rain_frequency.json`), so the debris-flow likelihoods are for storms expected nearly every winter.

21. **U.S. Geological Survey (2025).** *Postfire debris-flow hazard assessment, Eaton Fire.* [doi:10.5066/P14EWYME](https://doi.org/10.5066/P14EWYME). The Palisades assessment is on ScienceBase.
    The per-segment inputs and likelihoods steps 14–15 reproduce.

## Team research

22. **Dylan [surname] (2025).** *[Title: paper on environmental drivers of southern California fires].* Course paper, [course / institution].
    **To fill in:** we don't have this paper yet. As described, it argues that southern California fire is mainly an environmental phenomenon, not only a social one, and that the region's natural fire cycle is about a century. If so, it sits with entries 6–8 above.

---

### How this maps onto the code

| Claim in the app | Built on |
|---|---|
| Spread physics (rate, wind, slope, ellipse) | 12, 13 |
| Wind field drives spread; Santa Ana event | 1, 3 |
| Burn probability from many simulated fires (step 17, `physics_mc`) | 14 |
| Learned risk models, tested across fires (step 17) | 15 |
| Construction features and structure loss (step 09b) | 10, 11 |
| WUI and where homes meet fuel (step 17 features) | 9, 11 |
| Debris-flow likelihood per design storm (steps 14–15) | 16, 18, 21 |
| How often each design storm comes (step 16) | 17, 20 |
| Why environment, not only people (context) | 2, 6, 7, 8, 22 |
