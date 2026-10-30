# Sentinel Ember data pipeline. Pick the fire with FIRE=<id> (see fire.yaml); default is eaton.
# Outputs land in ../web/public/data/$(FIRE)/.
#
#   make all    full regeneration (needs network; FIRMS needs FIRMS_MAP_KEY, others are no-key)
#   make test   offline unit + contract tests against committed outputs (TEST_FIRES=eaton,palisades)
#   make eval   offline benchmarks (synthetic ignition recovery, Eaton hold-out) → ../web/public/data/<fire>/eval/
#               QUICK=1 runs the first 5 synthetic cases (identical to the first 5 of the full run);
#               EVAL_DIR=/some/dir writes there instead of overwriting the committed results

FIRE ?=
TEST_FIRES ?= eaton,palisades
RUN := FIRE=$(FIRE) uv run python -m

.PHONY: all aoi dem landcover firms perimeters arrival weather severity vectors exposure events ignition \
        test eval report smoke-meta clean-cache

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
	EVAL_DIR=$(EVAL_DIR) $(RUN) steps.s11_ignition --eval-only $(if $(QUICK),--cases 5,)

# Thursday checkpoint: both Meta models answer a real request (needs MODEL_API_KEY).
smoke-meta:
	uv run --extra sam python -m tools.smoke_meta $(ARGS)

clean-cache:
	rm -rf raw work

report:
	uv run python -m tools.report
