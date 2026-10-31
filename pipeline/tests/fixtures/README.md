# Test fixtures

## debris_inventory_sample.csv

A small stratified sample of USGS's runoff-generated postfire debris-flow inventory, so the
debris-flow tests (`tests/test_s14_debris.py`) run without `pipeline/work/`:

> Graber, A.P., Gorr, A.N., Kean, J.W., Kostelnik, J., Rengers, F.K., Selander, B.D., and Thomas,
> M.A., 2026, USGS runoff-generated postfire debris-flow inventory: U.S. Geological Survey data
> release, https://doi.org/10.5066/P1R9VXC4 (CC0).

292 records from 10 fires (110 debris flows), copied verbatim with every column; 286 of them pass
step 14's filters (108 from the Staley et al. (2016) inventory M1 was fitted on). From each fire,
its 3 largest fire-storm groups with both outcomes and 2 groups with one outcome, up to 6 debris
flows and 6 non-flows per group, plus up to 2 records the filters drop. The fires, and why each is
in, are in `make_debris_fixture.py`. It holds no soil moisture (step 14 fetches that from
Open-Meteo): the tests give each fire and storm a stand-in value.

Regenerate from pipeline/ (reads `work/debris_flow/USGS_RG_PFDF_Inventory_v1.csv`, which step 14
downloads):

    uv run python tests/fixtures/make_debris_fixture.py

`test_the_fixture_is_the_scripts_sample_of_the_inventory` checks the committed file against the
script when the inventory is in `work/`.
