# Sentinel Ember data pipeline. Pick the fire with FIRE=<id> (see fire.yaml); default is eaton.
# Outputs land in ../web/public/data/$(FIRE)/.
#
#   make all    full regeneration (needs network; FIRMS needs FIRMS_MAP_KEY, others are no-key)
#   make test   offline unit + contract tests against committed outputs (TEST_FIRES=eaton,palisades)
#   make eval   offline: the real ignition hold-out (its own length-to-breadth selection, the committed
#               calibration); reproduces eval/ignition_holdout.json exactly. 5-15 min for Eaton, about 12
#               for Palisades. QUICK=1 instead recomputes the first 2 synthetic cases, compares them with
#               eval/ignition_synthetic.json and writes the result to ignition_check.json, about 8 min.
#               Without FIRE it runs both fires (EVAL_FIRES), one after the other; FIRE=<id> runs one.
#               EVAL_DIR=/some/dir writes there instead of overwriting the committed results (quoted, so
#               paths with spaces work). Without FIRE, each fire gets its own suffix: /some/dir-eaton,
#               /some/dir-palisades
#   make eval-full  the whole synthetic benchmark (30 cases, both scenarios) and the wind ablation;
#               about 70 min for Eaton and 100 min for Palisades on a 10-core laptop

FIRE ?=
TEST_FIRES ?= eaton,palisades
EVAL_FIRES ?= eaton palisades
RUN := FIRE=$(FIRE) uv run python -m

.PHONY: all aoi dem landcover firms perimeters arrival weather severity vectors exposure events ignition \
        debris test eval eval-full report smoke-meta clean-cache

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

# Post-fire debris flows (Risk tab): models on USGS's inventory (14), then USGS's segments per fire (15).
debris:
	uv run python -m steps.s14_debris_models
	FIRE=eaton uv run python -m steps.s15_debris_fire
	FIRE=palisades uv run python -m steps.s15_debris_fire

test:
	TEST_FIRES=$(TEST_FIRES) uv run pytest -q tests

# FIRE=<id> keeps EVAL_DIR as given; without FIRE, each fire in EVAL_FIRES writes to "$(EVAL_DIR)-<fire>".
eval:
	@set -e; for f in $(or $(FIRE),$(EVAL_FIRES)); do \
	  dir="$(EVAL_DIR)"; \
	  if [ -n "$$dir" ] && [ -z "$(FIRE)" ]; then dir="$${dir%/}-$$f"; fi; \
	  echo "make eval: $$f -> $${dir:-../web/public/data/$$f/eval}"; \
	  FIRE=$$f EVAL_DIR="$$dir" uv run python -m steps.s11_ignition --eval-only $(if $(QUICK),--cases 2 --check,--cases 0); \
	done

eval-full:
	EVAL_DIR="$(EVAL_DIR)" $(RUN) steps.s11_ignition --eval-only --ablation

# Thursday checkpoint: both Meta models answer a real request (needs MODEL_API_KEY).
smoke-meta:
	uv run --extra sam python -m tools.smoke_meta $(ARGS)

clean-cache:
	rm -rf raw work

report:
	uv run python -m tools.report
