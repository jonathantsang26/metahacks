# Sentinel Ember data pipeline. Pick the fire with FIRE=<id> (see fire.yaml); default is eaton.
# Outputs land in ../web/public/data/$(FIRE)/.

FIRE ?=
RUN := FIRE=$(FIRE) uv run python -m

.PHONY: all aoi dem smoke-meta clean-cache

# Steps implemented so far. Add each step here as it lands.
all: aoi dem

aoi:
	$(RUN) steps.s01_aoi

dem: aoi
	$(RUN) steps.s02_dem

# Thursday checkpoint: both Meta models answer a real request (needs MODEL_API_KEY).
smoke-meta:
	uv run --extra sam python -m tools.smoke_meta $(ARGS)

clean-cache:
	rm -rf raw work
