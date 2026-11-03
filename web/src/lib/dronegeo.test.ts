import {describe, expect, it} from 'vitest';
import {
  detectionToMapPoint,
  enuToLonLat,
  frameFootprint,
  locateBox,
  lonLatToEnu,
  pixelRay,
  pixelToGround,
  poseFromTelemetry,
  type CameraIntrinsics,
  type CameraPose,
  type DemSampler
} from './dronegeo';
import {parseDjiSrt} from './dji-srt';

// Synthetic poses and terrain only: none of this is real flight data.
const LON0 = -118.1;
const LAT0 = 34.2;
const cam: CameraIntrinsics = {hfovDeg: 90, width: 1920, height: 1080};
const flatAt = (z: number): DemSampler => () => z;

describe('camera model', () => {
  it('nadir camera: the frame centre maps straight below', () => {
    const pose: CameraPose = {lon: LON0, lat: LAT0, altMslM: 600, yawDeg: 37, pitchDeg: -90};
    for (const opts of [{flatElevM: 500}, {dem: flatAt(500)}]) {
      const g = pixelToGround(pose, cam, cam.width / 2, cam.height / 2, opts)!;
      expect(g.groundRangeM).toBeLessThan(0.01);
      expect(g.slantRangeM).toBeCloseTo(100, 1);
      expect(g.lon).toBeCloseTo(LON0, 7);
      expect(g.lat).toBeCloseTo(LAT0, 7);
      expect(g.depressionDeg).toBeCloseTo(90, 5);
    }
  });

  it('nadir footprint: half-width = height × tan(hfov/2), top edge toward the heading', () => {
    const pose: CameraPose = {lon: LON0, lat: LAT0, altMslM: 100, yawDeg: 0, pitchDeg: -90};
    const fp = frameFootprint(pose, cam, {flatElevM: 0});
    expect(fp.polygon).toHaveLength(5);
    const [tl, tr, br, bl] = fp.corners.map(c => c!);
    expect(tl.east).toBeCloseTo(-100, 3);
    expect(tl.north).toBeCloseTo(100 * (1080 / 1920), 3);
    expect(tr.east).toBeCloseTo(100, 3);
    expect(br.north).toBeCloseTo(-56.25, 3);
    expect(bl.east).toBeCloseTo(-100, 3);
  });

  it('oblique on flat ground: distance = height / tan(depression), along the heading', () => {
    for (const [yaw, pitch] of [[0, -30], [90, -45], [225, -10]]) {
      const pose: CameraPose = {lon: LON0, lat: LAT0, altMslM: 250, yawDeg: yaw, pitchDeg: pitch};
      const g = pixelToGround(pose, cam, cam.width / 2, cam.height / 2, {dem: flatAt(50)})!;
      const expected = 200 / Math.tan((-pitch * Math.PI) / 180);
      expect(g.groundRangeM).toBeCloseTo(expected, 1);
      const bearing = ((Math.atan2(g.east, g.north) * 180) / Math.PI + 360) % 360;
      expect(bearing).toBeCloseTo(yaw, 3);
      // And the lon/lat agrees with the ENU offset.
      const [e, n] = lonLatToEnu(LON0, LAT0, g.lon, g.lat);
      expect(e).toBeCloseTo(g.east, 3);
      expect(n).toBeCloseTo(g.north, 3);
    }
  });

  it('roll turns the image: with +90° roll a nadir frame’s right edge points south', () => {
    const pose: CameraPose = {lon: LON0, lat: LAT0, altMslM: 100, yawDeg: 0, pitchDeg: -90, rollDeg: 90};
    // Not physical for a gimbal, but it pins the sign convention.
    const d = pixelRay(pose, cam, cam.width, cam.height / 2);
    expect(d[1]).toBeCloseTo(-Math.SQRT1_2, 6);
    expect(Math.abs(d[0])).toBeLessThan(1e-9);
    const level: CameraPose = {lon: LON0, lat: LAT0, altMslM: 100, yawDeg: 0, pitchDeg: 0, rollDeg: 10};
    // Level camera rolled right: the right half of the frame looks slightly down.
    expect(pixelRay(level, cam, cam.width, cam.height / 2)[2]).toBeLessThan(0);
    expect(pixelRay(level, cam, 0, cam.height / 2)[2]).toBeGreaterThan(0);
  });

  it('sloped synthetic DEM: matches the closed-form ray/plane intersection', () => {
    // Ground rises 0.3 m per m toward the east from 100 m at the drone.
    const s = 0.3;
    const dem: DemSampler = (lon, lat) => 100 + s * lonLatToEnu(LON0, LAT0, lon, lat)[0];
    const H = 400;
    const dep = 20; // degrees below horizontal, looking east
    const pose: CameraPose = {lon: LON0, lat: LAT0, altMslM: H, yawDeg: 90, pitchDeg: -dep};
    const g = pixelToGround(pose, cam, cam.width / 2, cam.height / 2, {dem})!;
    const sin = Math.sin((dep * Math.PI) / 180);
    const cos = Math.cos((dep * Math.PI) / 180);
    const t = (H - 100) / (sin + s * cos);
    expect(g.source).toBe('dem');
    expect(g.slantRangeM).toBeCloseTo(t, 1);
    expect(g.east).toBeCloseTo(t * cos, 1);
    expect(g.elevM).toBeCloseTo(100 + s * t * cos, 1);
    // Flat ground at the drone's ground level would put it much further out.
    const flat = pixelToGround(pose, cam, cam.width / 2, cam.height / 2, {flatElevM: 100})!;
    expect(flat.east).toBeGreaterThan(g.east * 1.5);
  });

  it('a ridge in front stops a ray that flat ground would not', () => {
    // A 300 m wall 1 km north; the drone is at 200 m looking 2° up.
    const dem: DemSampler = (lon, lat) => (lonLatToEnu(LON0, LAT0, lon, lat)[1] > 1000 ? 300 : 0);
    const pose: CameraPose = {lon: LON0, lat: LAT0, altMslM: 200, yawDeg: 0, pitchDeg: 2};
    expect(pixelToGround(pose, cam, cam.width / 2, cam.height / 2, {flatElevM: 0})).toBeNull();
    const g = pixelToGround(pose, cam, cam.width / 2, cam.height / 2, {dem})!;
    expect(g.north).toBeCloseTo(1000, 0);
    expect(g.elevM).toBe(300);
  });

  it('falls back to the flat plane outside DEM coverage', () => {
    const dem: DemSampler = (lon, lat) => (lonLatToEnu(LON0, LAT0, lon, lat)[1] < 50 ? 0 : null);
    const pose: CameraPose = {lon: LON0, lat: LAT0, altMslM: 100, yawDeg: 0, pitchDeg: -45};
    const g = pixelToGround(pose, cam, cam.width / 2, cam.height / 2, {dem})!;
    expect(g.source).toBe('flat');
    expect(g.north).toBeCloseTo(100, 1);
  });

  it('rays above the horizon return null; oblique footprints that show sky have no polygon', () => {
    const pose: CameraPose = {lon: LON0, lat: LAT0, altMslM: 100, yawDeg: 0, pitchDeg: -10};
    expect(pixelToGround(pose, cam, cam.width / 2, 0, {flatElevM: 0})).toBeNull();
    expect(pixelToGround(pose, cam, cam.width / 2, 0, {dem: flatAt(0), maxTerrainElevM: 0})).toBeNull();
    expect(pixelToGround(pose, cam, cam.width / 2, 0, {dem: flatAt(0)})).toBeNull();
    const fp = frameFootprint(pose, cam, {flatElevM: 0});
    expect(fp.polygon).toBeNull();
    expect(fp.corners[2]).not.toBeNull();
  });

  it('a camera below the ground returns null', () => {
    const pose: CameraPose = {lon: LON0, lat: LAT0, altMslM: 50, yawDeg: 0, pitchDeg: -90};
    expect(pixelToGround(pose, cam, 960, 540, {dem: flatAt(80)})).toBeNull();
  });

  it('enuToLonLat and lonLatToEnu invert each other', () => {
    const [lon, lat] = enuToLonLat(LON0, LAT0, 1234, -567);
    const [e, n] = lonLatToEnu(LON0, LAT0, lon, lat);
    expect(e).toBeCloseTo(1234, 6);
    expect(n).toBeCloseTo(-567, 6);
  });
});

describe('detections to map points', () => {
  const pose: CameraPose = {lon: LON0, lat: LAT0, altMslM: 300, yawDeg: 0, pitchDeg: -45};

  it('projects the box bottom-centre and gives an error budget', () => {
    const det = {box: [900, 500, 1020, 540] as [number, number, number, number], cls: 'fire', conf: 0.8};
    const p = locateBox(det, pose, cam, {flatElevM: 0})!;
    expect(p.anchor).toBe('bottom-center');
    expect(p.pixel).toEqual([960, 540]);
    expect(p.groundRangeM).toBeCloseTo(300, 1);
    const u = p.uncertainty;
    expect(u.radiusM).toBeCloseTo(Math.hypot(u.gpsM, u.altitudeM, u.terrainM, u.attitudeM, u.pixelM), 6);
    // At 45° a vertical error moves the point by the same amount on the ground.
    expect(u.altitudeM).toBeCloseTo(3, 6);
    expect(u.terrainM).toBeCloseTo(20, 6); // flat fallback default
    expect(u.pixelM).toBeGreaterThan(0);
    const c = locateBox(det, pose, cam, {flatElevM: 0, anchor: 'center'})!;
    expect(c.groundRangeM).toBeGreaterThan(p.groundRangeM);
  });

  it('the error grows with range and shallower angles', () => {
    const det = {box: [940, 520, 980, 540] as [number, number, number, number], cls: 'smoke', conf: 0.5};
    const steep = locateBox(det, pose, cam, {dem: flatAt(0)})!;
    const shallow = locateBox(det, {...pose, pitchDeg: -10}, cam, {dem: flatAt(0)})!;
    expect(shallow.uncertainty.radiusM).toBeGreaterThan(steep.uncertainty.radiusM * 3);
  });

  it('box + SRT track → timestamped point (synthetic track)', () => {
    // Format sample written for the test, not real flight data: two blocks 1 s apart, flying north.
    const srt = `1
00:00:00,000 --> 00:00:00,033
<font size="28">SrtCnt : 1, DiffTime : 33ms
2025-01-08 10:00:00.000
[latitude: 34.200000] [longitude: -118.100000] [rel_alt: 120.000 abs_alt: 999.000] [gb_yaw : 0.0 gb_pitch : -90.0 gb_roll : 0.0] </font>

2
00:00:01,000 --> 00:00:01,033
<font size="28">SrtCnt : 31, DiffTime : 33ms
2025-01-08 10:00:01.000
[latitude: 34.200100] [longitude: -118.100000] [rel_alt: 120.000 abs_alt: 999.000] [gb_yaw : 0.0 gb_pitch : -90.0 gb_roll : 0.0] </font>
`;
    const {frames} = parseDjiSrt(srt);
    const det = {box: [900, 500, 1020, 580] as [number, number, number, number], cls: 'fire', conf: 0.9, videoTimeS: 0.5};
    const out = detectionToMapPoint(det, frames, cam, {dem: flatAt(200), takeoffElevM: 200, utcOffsetMin: -480, anchor: 'center'});
    if ('error' in out) throw new Error(out.error);
    expect(out.t).toBe('2025-01-08T18:00:00.500Z');
    expect(out.altSource).toBe('rel+takeoff');
    expect(out.pose.altMslM).toBe(320);
    expect(out.lat).toBeCloseTo(34.20005, 6);
    expect(out.lon).toBeCloseTo(-118.1, 6);
    expect(out.slantRangeM).toBeCloseTo(120, 1);

    expect(detectionToMapPoint({...det, videoTimeS: 30}, frames, cam, {takeoffElevM: 200})).toHaveProperty('error');
    // Without the takeoff elevation it falls back to abs_alt.
    const abs = detectionToMapPoint(det, frames, cam, {flatElevM: 200});
    if ('error' in abs) throw new Error(abs.error);
    expect(abs.altSource).toBe('abs');
    expect(abs.t).toBeNull();
  });

  it('reports what is missing from a consumer SRT with no gimbal angles', () => {
    const f = {index: 1, startS: 0, endS: 0.03, lat: LAT0, lon: LON0, relAltM: 80, raw: {}};
    expect(poseFromTelemetry(f, {takeoffElevM: 10})).toHaveProperty('error');
    const ok = poseFromTelemetry(f, {takeoffElevM: 10, yawDeg: 45, pitchDeg: -30});
    expect('pose' in ok && ok.pose.altMslM).toBe(90);
  });
});
