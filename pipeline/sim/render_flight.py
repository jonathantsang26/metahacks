"""Render a swarm rollout as video: the MuJoCo terrain heightfield, the drones replayed from the
rollout's recorded tracks, the burned area at the replay time, and a slow orbiting camera.

    uv run --extra sim python -m sim.render_flight --rollout ../web/public/data/eaton/swarm/muse-fcst-muse_s0.json \
        --from-s 0 --to-s 2700 --seconds 12 --out /tmp/flight.mp4

Tracks are sampled every `track_s` (30 s); positions in between are interpolated. The drones are
drawn larger than life (a 0.6 m drone is invisible at this scale), with short trails. It is a
replay of the simulation: nothing here is real flight.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import tempfile
from pathlib import Path

import mujoco
import numpy as np

from .world import World

W, H, FPS = 1920, 1080, 30
COLORS = [(0.31, 0.89, 0.94), (1.0, 0.78, 0.25), (0.55, 1.0, 0.45), (1.0, 0.45, 0.75), (0.65, 0.6, 1.0), (1.0, 1.0, 1.0)]


def terrain_texture(world: World, t_abs: float) -> np.ndarray:
    """RGB, row 0 = north: hillshade over an elevation tint, burned cells red-black, the active edge orange."""
    z = world.elevation
    gy, gx = np.gradient(z, world.cell_m[1], world.cell_m[0])
    az, alt = np.radians(315), np.radians(40)
    slope = np.arctan(np.hypot(gx, gy))
    aspect = np.arctan2(-gx, gy)
    shade = np.clip(np.sin(alt) * np.cos(slope) + np.cos(alt) * np.sin(slope) * np.cos(az - aspect), 0, 1)
    zn = (z - z.min()) / max(np.ptp(z), 1)
    low, high = np.array([0.55, 0.53, 0.42]), np.array([0.36, 0.45, 0.28])
    base = low[None, None] * (1 - zn[..., None]) + high[None, None] * zn[..., None]
    rgb = base * (0.45 + 0.75 * shade[..., None])
    a = world.arrival
    burned = a <= t_abs
    active = burned & (a > t_abs - 3600)
    rgb[burned] = rgb[burned] * 0.35 + np.array([0.35, 0.05, 0.03]) * 0.65
    rgb[active] = np.array([1.0, 0.42, 0.12])
    return (np.clip(rgb, 0, 1) * 255).astype(np.uint8)


def build(world: World, n: int, tex: np.ndarray, drone_r: float) -> mujoco.MjModel:
    z = world.elevation
    zmin, zmax = float(z.min()), float(z.max())
    Hh, Ww = z.shape
    sx, sy = world.size_m
    drones = "".join(
        f'<body name="d{i}" mocap="true" pos="0 0 -1000"><geom type="sphere" size="{drone_r}" rgba="{c[0]} {c[1]} {c[2]} 1" '
        f'contype="0" conaffinity="0"/></body>' for i, c in zip(range(n), COLORS * 3)
    )
    xml = f"""<mujoco model="swarm-render">
  <visual><global offwidth="{W}" offheight="{H}" fovy="40"/><quality shadowsize="4096"/>
    <headlight ambient="0.45 0.45 0.45" diffuse="0.6 0.6 0.6" specular="0 0 0"/><map zfar="200" znear="0.001"/></visual>
  <asset>
    <hfield name="terrain" nrow="{Hh}" ncol="{Ww}" size="{sx / 2:.2f} {sy / 2:.2f} {max(zmax - zmin, 1):.2f} 10"/>
    <texture name="tt" type="2d" width="{tex.shape[1]}" height="{tex.shape[0]}" builtin="flat" rgb1="1 1 1"/>
    <material name="tm" texture="tt" texuniform="false" texrepeat="1 1" specular="0" shininess="0"/>
    <texture name="sky" type="skybox" builtin="gradient" rgb1="0.80 0.86 0.92" rgb2="0.98 0.95 0.90" width="512" height="512"/>
  </asset>
  <worldbody>
    <light directional="true" dir="-0.4 -0.3 -1" diffuse="0.5 0.5 0.5" castshadow="true"/>
    <geom name="terrain" type="hfield" hfield="terrain" material="tm" pos="{sx / 2:.2f} {sy / 2:.2f} {zmin:.2f}"/>
    {drones}
  </worldbody>
</mujoco>"""
    m = mujoco.MjModel.from_xml_string(xml)
    m.hfield_data[:] = (np.flipud(z) - zmin).ravel() / max(zmax - zmin, 1)
    tid = mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_TEXTURE, "tt")
    adr, th, tw = m.tex_adr[tid], m.tex_height[tid], m.tex_width[tid]
    m.tex_data[adr:adr + th * tw * 3] = np.flipud(tex).reshape(-1)  # texture row 0 is south, like the hfield
    return m


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--rollout', required=True)
    ap.add_argument('--from-s', type=float, default=0.0, help='replay start, seconds into the rollout')
    ap.add_argument('--to-s', type=float, default=2700.0)
    ap.add_argument('--seconds', type=float, default=12.0, help='video length')
    ap.add_argument('--drone-r', type=float, default=55.0, help='drawn drone radius, m')
    ap.add_argument('--out', required=True)
    a = ap.parse_args()

    ro = json.loads(Path(a.rollout).read_text())
    world = World(ro['config']['fire'])
    from .world import parse_t
    t0 = parse_t(ro['t0'])
    tracks = [np.array(tr, dtype=float) for tr in ro['tracks']]  # [t_s, lon, lat, z, mode, battery]
    n = len(tracks)
    tex = terrain_texture(world, t0 + (a.from_s + a.to_s) / 2)
    m = build(world, n, tex, a.drone_r)
    d = mujoco.MjData(m)
    r = mujoco.Renderer(m, H, W)
    sx, sy = world.size_m

    def pos_at(i, ts):
        tr = tracks[i]
        x, y = world.to_local(np.interp(ts, tr[:, 0], tr[:, 1]), np.interp(ts, tr[:, 0], tr[:, 2]))
        return np.array([float(x), float(y), float(np.interp(ts, tr[:, 0], tr[:, 3]))])

    frames = int(a.seconds * FPS)
    cam = mujoco.MjvCamera()
    cam.type = mujoco.mjtCamera.mjCAMERA_FREE
    with tempfile.TemporaryDirectory() as tmp:
        ff = subprocess.Popen(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}', '-r', str(FPS),
                               '-i', '-', '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', a.out],
                              stdin=subprocess.PIPE)
        # A fixed centre (where the swarm works over the whole window) and a slow orbit: following the
        # swarm's centroid jumps whenever a drone returns to base.
        samples = np.array([pos_at(i, t) for t in np.linspace(a.from_s, a.to_s, 60) for i in range(n)])
        centre = samples.mean(axis=0)
        centre[2] = float(world.ground(centre[0], centre[1]))
        for f in range(frames):
            k = f / max(frames - 1, 1)
            ts = a.from_s + (a.to_s - a.from_s) * k
            P = np.array([pos_at(i, ts) for i in range(n)])
            for i in range(n):
                d.mocap_pos[i] = P[i]
            mujoco.mj_forward(m, d)
            cam.lookat[:] = centre
            cam.distance = 9500 + 2500 * k  # constant-speed, a touch wider by the end
            cam.azimuth = 215 + 50 * k
            cam.elevation = -36 - 6 * k
            r.update_scene(d, cam)
            # Trails: small spheres at the last 6 minutes of each drone's path.
            for i in range(n):
                for back in range(1, 13):
                    tb = ts - back * 30
                    if tb < tracks[i][0, 0] or r.scene.ngeom >= r.scene.maxgeom:
                        break
                    g = r.scene.geoms[r.scene.ngeom]
                    col = COLORS[i % len(COLORS)]
                    mujoco.mjv_initGeom(g, mujoco.mjtGeom.mjGEOM_SPHERE, np.array([a.drone_r * 0.5] * 3), pos_at(i, tb), np.eye(3).ravel(),
                                        np.array([*col, 0.75 * (1 - back / 13)], dtype=np.float32))
                    r.scene.ngeom += 1
            ff.stdin.write(r.render().tobytes())
        ff.stdin.close()
        ff.wait()
    print(a.out, frames / FPS, 's')


if __name__ == '__main__':
    main()
