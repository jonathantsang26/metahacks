import {describe, expect, it} from 'vitest';
import {courseOverGround, frameTimeUtc, parseDjiSrt, telemetryAt} from './dji-srt';

// The SRT samples below are FORMAT SAMPLES written by hand from the published layouts of DJI's
// subtitle telemetry. The numbers are made up; they are not real flight data.

const BRACKET = `1
00:00:00,000 --> 00:00:00,033
<font size="28">FrameCnt: 1, DiffTime: 33ms
2024-05-01 14:22:31.123
[iso: 100] [shutter: 1/1000.0] [fnum: 2.8] [ev: 0] [ct: 5500] [color_md: default] [focal_len: 24.00] [latitude: 34.123456] [longitude: -118.123456] [rel_alt: 120.500 abs_alt: 450.123] </font>

2
00:00:00,033 --> 00:00:00,067
<font size="28">FrameCnt: 2, DiffTime: 34ms
2024-05-01 14:22:31.157
[iso: 100] [shutter: 1/1000.0] [fnum: 2.8] [ev: 0] [ct: 5500] [color_md: default] [focal_len: 24.00] [latitude: 34.123466] [longitude: -118.123446] [rel_alt: 121.500 abs_alt: 451.123] </font>
`;

// Enterprise layout: spaces before colons, the "longtitude" misspelling, gimbal angles, CRLF.
const ENTERPRISE = [
  '1',
  '00:00:10,000 --> 00:00:10,033',
  '<font size="28">SrtCnt : 301, DiffTime : 33ms',
  '2023-02-14 10:37:15.360',
  '[iso : 100] [shutter : 1/320.0] [fnum : 2.8] [ev : 0] [focal_len : 24.00] [dzoom : 1.00] [latitude : 22.546440] [longtitude : 113.956700] [rel_alt: 99.835 abs_alt: 168.920] [gb_yaw : 179.0 gb_pitch : -45.0 gb_roll : 0.0] </font>',
  '',
  '2',
  '00:00:10,033 --> 00:00:10,067',
  '<font size="28">SrtCnt : 302, DiffTime : 34ms',
  '2023-02-14 10:37:15.394',
  '[iso : 100] [shutter : 1/320.0] [fnum : 2.8] [ev : 0] [focal_len : 24.00] [dzoom : 1.00] [latitude : 22.546450] [longtitude : 113.956700] [rel_alt: 99.900 abs_alt: 169.000] [gb_yaw : -179.0 gb_pitch : -44.0 gb_roll : 0.0] </font>',
  ''
].join('\r\n');

const LEGACY = `1
00:00:00,000 --> 00:00:01,000
HOME(-118.1500,34.2000) 2017.08.05 14:11:51
GPS(-118.1510,34.2010,19) BAROMETER:62.1
ISO:100 Shutter:60 EV:0 Fnum:2.2

2
00:00:01,000 --> 00:00:02,000
HOME(-118.1500,34.2000) 2017.08.05 14:11:52
GPS(-118.1512,34.2012,19) BAROMETER:63.0
ISO:100 Shutter:60 EV:0 Fnum:2.2

3
00:00:02,000 --> 00:00:03,000
HOME(-118.1500,34.2000) 2017.08.05 14:11:53
GPS(0.0,0.0,0) BAROMETER:63.0
ISO:100 Shutter:60 EV:0 Fnum:2.2
`;

const INLINE = `1
00:00:00,000 --> 00:00:01,000
F/2.8, SS 320.38, ISO 100, EV 0, DZOOM 1.000, GPS (-122.4148, 37.8063, 19), D 24.38m, H 6.80m, H.S 0.00m/s, V.S 0.00m/s
`;

describe('parseDjiSrt', () => {
  it('reads the bracket layout (Mini / Air / Mavic 3)', () => {
    const {format, frames, warnings} = parseDjiSrt(BRACKET);
    expect(format).toBe('bracket');
    expect(frames).toHaveLength(2);
    const [a, b] = frames;
    expect(a).toMatchObject({index: 1, frameCnt: 1, startS: 0, endS: 0.033, lat: 34.123456, lon: -118.123456, relAltM: 120.5, absAltM: 450.123, focalLenMm: 24});
    expect(a.raw.iso).toBe(100);
    expect(a.raw.shutter).toBeUndefined(); // 1/1000.0 is a fraction, not a number
    expect(new Date(a.localMs!).toISOString()).toBe('2024-05-01T14:22:31.123Z');
    expect(b.startS).toBeCloseTo(0.033, 6);
    expect(a.gimbalYawDeg).toBeUndefined();
    expect(warnings.some(w => w.includes('gimbal yaw'))).toBe(true);
  });

  it('reads the enterprise bracket layout with gimbal angles and the longtitude spelling', () => {
    const {format, frames, warnings} = parseDjiSrt(ENTERPRISE);
    expect(format).toBe('bracket');
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({frameCnt: 301, lat: 22.54644, lon: 113.9567, relAltM: 99.835, gimbalYawDeg: 179, gimbalPitchDeg: -45, gimbalRollDeg: 0});
    expect(frames[0].startS).toBe(10);
    expect(warnings).toEqual([]);
  });

  it('reads the legacy HOME/GPS/BAROMETER layout (Phantom 4): longitude first, no-fix blocks skipped', () => {
    const {format, frames, warnings} = parseDjiSrt(LEGACY);
    expect(format).toBe('legacy');
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({lon: -118.151, lat: 34.201, relAltM: 62.1, homeLon: -118.15, homeLat: 34.2});
    expect(new Date(frames[1].localMs!).toISOString()).toBe('2017-08-05T14:11:52.000Z');
    expect(warnings.some(w => w.includes('without a GNSS fix'))).toBe(true);
  });

  it('reads the inline layout (Mavic Pro / Spark)', () => {
    const {format, frames} = parseDjiSrt(INLINE);
    expect(format).toBe('inline');
    expect(frames[0]).toMatchObject({lon: -122.4148, lat: 37.8063, relAltM: 6.8});
    expect(frames[0].localMs).toBeUndefined();
  });

  it('returns nothing, with a warning, for text that is not telemetry', () => {
    const {frames, warnings} = parseDjiSrt('1\n00:00:00,000 --> 00:00:01,000\nHello world\n');
    expect(frames).toEqual([]);
    expect(warnings[0]).toMatch(/no telemetry/);
  });
});

describe('telemetryAt', () => {
  it('interpolates position, altitude, time and headings across north', () => {
    const {frames} = parseDjiSrt(ENTERPRISE);
    const mid = telemetryAt(frames, 10.0165)!;
    expect(mid.lat).toBeCloseTo(22.546445, 7);
    expect(mid.gimbalPitchDeg).toBeCloseTo(-44.5, 6);
    // 179° → −179° goes through 180, not through 0.
    expect(Math.abs(Math.abs(mid.gimbalYawDeg!) - 180)).toBeLessThan(1e-6);
    expect(frameTimeUtc(mid, 480)).toBe('2023-02-14T02:37:15.377Z');
    expect(frameTimeUtc(mid, undefined)).toBeNull();
    expect(telemetryAt(frames, 5)).toBeNull();
    expect(telemetryAt(frames, 10.05)!.lat).toBe(frames[1].lat);
  });

  it('course over ground stands in for a missing heading only when moving', () => {
    const {frames} = parseDjiSrt(LEGACY);
    // ~22 m north and ~18 m west in 1 s.
    const c = courseOverGround(frames, 0)!;
    expect(c).toBeGreaterThan(270);
    expect(c).toBeLessThan(360);
    expect(courseOverGround(frames, 0, 100)).toBeNull();
  });
});
