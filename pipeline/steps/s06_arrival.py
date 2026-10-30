"""06: Arrival-time raster: when each cell burned (BUILD.md §3).

Inputs:  perimeters.geojson + hotspots.geojson + dem.json grid
Outputs: arrival.png (red channel: 1–254 = (code−1)/253 of aoi.window_utc, 255 = never burned;
         same bounds as dem.png, row 0 = north; see BUILD.md §3), isochrones.geojson

Not implemented yet. See docs/spec/BUILD.md §5 and §7.
"""

if __name__ == "__main__":
    raise SystemExit("s06_arrival: not implemented yet (docs/spec/BUILD.md §7)")
