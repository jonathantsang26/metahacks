"""Swarm: a MuJoCo drone-swarm environment replayed on a reconstructed fire.

Real inputs: the terrain (dem.png), the fire's spread (arrival.png, interpolated between mapped
perimeters) and the wind (HRRR, wind_field.json). Simulated: the drones, their sensors, their
batteries and every rollout. Everything this package writes is labelled SIM.
"""
