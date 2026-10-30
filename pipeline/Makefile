# Sentinel Ember data pipeline. Pick the fire with FIRE=<id> (see fire.yaml); default is eaton.
# Outputs land in ../web/public/data/$(FIRE)/.
#
#   make all    full regeneration (needs network; FIRMS needs FIRMS_MAP_KEY, others are no-key)
#   make test   offline unit + contract tests against committed outputs (TEST_FIRES=eaton,palisades)
#   make eval   offline, 5-15 min: the real ignition hold-out (its own length-to-breadth selection,
#               the committed calibration); reproduces eval/ignition_holdout.json exactly. QUICK=1 instead
#               recomputes the first 2 synthetic cases, compares them with eval/ignition_synthetic.json
#               and writes the result to ignition_check.json, about 8 min.
#               EVAL_DIR=/some/dir writes there instead of overwriting the committed results (quoted, so
#               paths with spaces work)
#   make eval-full  the whole synthetic benchmark (30 cases, both scenarios) and the wind ablation;
#               about 70 min for Eaton and 100 min for Palisades on a 10-core laptop

FIRE ?=
TEST_FIRES ?= eaton,palisades
RUN := FIRE=$(FIRE) uv run python -m

.PHONY: all aoi dem landcover firms perimeters arrival weather severity vectors exposure events ignition \
        test eval eval-full report smoke-meta clean-cache

all: aoi dem landcover firms perimeters weather severity vectors arrival ignition events exposure

aoi:
	$(RUN) steps.s01_aoi

dem: aoi
	$(RUN) steps.s02_dem

landcover: dem
	$(RUN) steps.s03_landcover

# Skips cleanly (and records why in the manifest) when FIRMS_MAP_KEY is not set.
firms: aoi
	$(RUN) steps.s04_firms

perimeters: aoi
	$(RUN) steps.s05_perimeters

weather: aoi
	$(RUN) steps.s07_weather

severity: dem
	$(RUN) steps.s08_severity

vectors: dem
	$(RUN) steps.s09_vectors

arrival: perimeters dem
	$(RUN) steps.s06_arrival

events: arrival ignition
	$(RUN) steps.s10_events

ignition: arrival weather landcover
	$(RUN) steps.s11_ignition

exposure: arrival vectors weather
	$(RUN) steps.s09b_exposure

test:
	TEST_FIRES=$(TEST_FIRES) uv run pytest -q tests

eval:
	EVAL_DIR="$(EVAL_DIR)" $(RUN) steps.s11_ignition --eval-only $(if $(QUICK),--cases 2 --check,--cases 0)

eval-full:
	EVAL_DIR="$(EVAL_DIR)" $(RUN) steps.s11_ignition --eval-only --ablation

# Thursday checkpoint: both Meta models answer a real request (needs MODEL_API_KEY).
smoke-meta:
	uv run --extra sam python -m tools.smoke_meta $(ARGS)

clean-cache:
	rm -rf raw work

report:
	uv run python -m tools.report
