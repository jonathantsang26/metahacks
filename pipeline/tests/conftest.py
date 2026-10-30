"""Shared fixtures: tests run offline against the committed outputs in web/public/data/<fire>/."""

import os

import pytest

from ember.config import load_fire

FIRES = [f for f in os.environ.get("TEST_FIRES", "eaton").split(",") if f]


@pytest.fixture(params=FIRES)
def fire(request):
    return load_fire(request.param)
