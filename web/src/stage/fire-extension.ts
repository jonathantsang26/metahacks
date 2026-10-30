/**
 * Render path A (BUILD.md §3): the fire lives in the terrain mesh's own fragment shader.
 *
 * Three rasters ride on the base texture's UVs (same bounds, row 0 = north):
 *
 * arrival.png, red = when each cell burned, relative to the arrival window: 1..254 → arrival
 * (code − 1) / 253 in [0, 1], 255 → never burned (pipeline step 06). It is read with texelFetch,
 * never filtered: interpolating between a burn time and 255 would invent late burns along every
 * edge. At replay time t:
 *   t < arrival                  unburned (base texture)
 *   0 ≤ t − arrival ≤ glow       active front (emissive orange-yellow)
 *   t − arrival > glow           charred, with embers fading out
 *
 * severity.png, red = AVIRIS-3 dNBR scaled to 1..255, 0 = no data: a red-orange wash. It is
 * post-fire imagery, so by default it only shows where the arrival raster says the fire has
 * already been at t; otherwise the replay would reveal the scar before the front gets there.
 * Also read with texelFetch: filtering would blend 0 (no data) into valid codes and paint a
 * fake low-severity fringe along every AVIRIS-3 coverage edge.
 *
 * ignition_posterior.png, red = relative posterior 0..255 (a model output): a violet heat
 * overlay, a hue kept apart from the fire and the observed scar so the two cannot be confused.
 *
 * The base texture itself is blended toward a flat neutral first (fireBase), so switching the
 * Terrain layer off or fading it changes only the ground under the fire, never the fire layers.
 *
 * Pass it to a TerrainLayer: extensions are forwarded to the mesh sublayer.
 */
import {LayerExtension} from '@deck.gl/core';
import type {DefaultProps, Layer, LayerContext} from '@deck.gl/core';
import type {Texture} from '@luma.gl/core';
import type {ShaderModule} from '@luma.gl/shadertools';

export type FireExtensionProps = {
  /** Weight of the stylized base texture: 1 = as is, 0 = flat neutral ground (Terrain layer off). */
  fireBase?: number;
  /** Arrival-time image (image, canvas or texture). Null leaves the terrain unburned. */
  fireArrival?: unknown;
  /** Replay position in [0, 1] of the arrival window. */
  fireTime?: number;
  /** Width of the glowing front, in the same normalized units. */
  fireGlow?: number;
  /** Draw the char and the front (the Fire Progression layer); the arrival still gates the scar when off. */
  fireVisible?: boolean;
  fireOpacity?: number;
  /** Show the burn scar only where the fire has arrived by fireTime. */
  fireGateScar?: boolean;
  /** severity.png; null hides the wash. */
  fireSeverity?: unknown;
  /** 0 hides the wash. */
  fireSeverityOpacity?: number;
  /** Red codes where the wash starts and where it reaches full strength. */
  fireSeverityRange?: [number, number];
  /** ignition_posterior.png; null hides the heat overlay. */
  fireIgnition?: unknown;
  /** 0 hides the heat overlay. */
  fireIgnitionOpacity?: number;
};

type RGB = [number, number, number];
/** Fire progression: the glowing front's base colour and the char it leaves (the key's swatches). */
export const FRONT: RGB = [255, 115, 20];
export const CHAR: RGB = [51, 43, 36];
/** Burn-scar wash (observed dNBR), low → high severity. The map key draws its swatches from here. */
export const SCAR_RAMP: [RGB, RGB] = [
  [242, 143, 66],
  [189, 28, 18]
];
/** Ignition posterior heat (a model output), low → mid → high. */
export const POSTERIOR_RAMP: [RGB, RGB, RGB] = [
  [222, 204, 255],
  [154, 98, 226],
  [96, 32, 150]
];
/** Flat ground when the Terrain layer is off: the app's card tone, still lit by the mesh normals. */
const NEUTRAL: RGB = [222, 218, 206];
const glsl = ([r, g, b]: RGB) => `vec3(${(r / 255).toFixed(3)}, ${(g / 255).toFixed(3)}, ${(b / 255).toFixed(3)})`;

type FireModuleProps = {
  arrival: Texture;
  severity: Texture;
  ignition: Texture;
  base: number;
  time: number;
  glow: number;
  enabled: boolean;
  opacity: number;
  gate: boolean;
  severityOpacity: number;
  severityLo: number;
  severityHi: number;
  ignitionOpacity: number;
};
type FireUniforms = {
  base: number;
  time: number;
  glow: number;
  enabled: number;
  opacity: number;
  gate: number;
  severityOpacity: number;
  severityLo: number;
  severityHi: number;
  ignitionOpacity: number;
};
type FireBindings = {fire_arrival: Texture; fire_severity: Texture; fire_ignition: Texture};

// Field order must match uniformTypes below.
const fs = /* glsl */ `\
layout(std140) uniform fireUniforms {
  float base;
  float time;
  float glow;
  float enabled;
  float opacity;
  float gate;
  float severityOpacity;
  float severityLo;
  float severityHi;
  float ignitionOpacity;
} fire;

uniform sampler2D fire_arrival;
uniform sampler2D fire_severity;
uniform sampler2D fire_ignition;

float fire_hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

// Nearest texel, no filtering and no mip level other than 0.
vec4 fire_texel(sampler2D tex, vec2 uv) {
  ivec2 size = textureSize(tex, 0);
  ivec2 px = clamp(ivec2(floor(uv * vec2(size))), ivec2(0), size - ivec2(1));
  return texelFetch(tex, px, 0);
}
`;

const inject = {
  'fs:DECKGL_FILTER_COLOR': /* glsl */ `
  color.rgb = mix(${glsl(NEUTRAL)}, color.rgb, fire.base);

  float fire_code = fire_texel(fire_arrival, geometry.uv).r * 255.0;
  float fire_at = (fire_code - 1.0) / 253.0;
  bool fire_burned = fire_code < 254.5 && fire.time >= fire_at;

  if (fire.enabled > 0.5 && fire_burned) {
    float since = fire.time - fire_at;
    float front = 1.0 - smoothstep(0.0, fire.glow, since);
    float speck = step(0.955, fire_hash(floor(geometry.uv * 1400.0)));
    float embers = speck * (1.0 - smoothstep(0.0, fire.glow * 8.0, since));
    vec3 charred = mix(color.rgb * 0.38, ${glsl(CHAR)}, 0.6);
    charred = mix(charred, vec3(0.98, 0.38, 0.08), embers * 0.85);
    vec3 flame = mix(${glsl(FRONT)}, vec3(1.0, 0.86, 0.52), front * front);
    color.rgb = mix(color.rgb, mix(charred, flame * 1.6, front), fire.opacity);
  }

  if (fire.severityOpacity > 0.0 && (fire.gate < 0.5 || fire_burned)) {
    float sev = fire_texel(fire_severity, geometry.uv).r * 255.0;
    if (sev >= fire.severityLo) {
      float s = smoothstep(fire.severityLo, fire.severityHi, sev);
      vec3 wash = mix(${glsl(SCAR_RAMP[0])}, ${glsl(SCAR_RAMP[1])}, s);
      color.rgb = mix(color.rgb, wash, fire.severityOpacity * (0.3 + 0.6 * s));
    }
  }

  if (fire.ignitionOpacity > 0.0) {
    float p = texture(fire_ignition, geometry.uv).r;
    if (p > 0.004) {
      vec3 heat = mix(${glsl(POSTERIOR_RAMP[0])}, ${glsl(POSTERIOR_RAMP[1])}, smoothstep(0.0, 0.5, p));
      heat = mix(heat, ${glsl(POSTERIOR_RAMP[2])}, smoothstep(0.5, 1.0, p));
      color.rgb = mix(color.rgb, heat, fire.ignitionOpacity * (0.25 + 0.65 * p));
    }
  }
`
};

const fireModule = {
  name: 'fire',
  fs,
  inject,
  getUniforms: (opts?: FireModuleProps | {}): Partial<FireUniforms & FireBindings> => {
    if (!opts || !('arrival' in opts)) return {};
    return {
      fire_arrival: opts.arrival,
      fire_severity: opts.severity,
      fire_ignition: opts.ignition,
      base: opts.base,
      time: opts.time,
      glow: opts.glow,
      enabled: opts.enabled ? 1 : 0,
      opacity: opts.opacity,
      gate: opts.gate ? 1 : 0,
      severityOpacity: opts.severityOpacity,
      severityLo: opts.severityLo,
      severityHi: opts.severityHi,
      ignitionOpacity: opts.ignitionOpacity
    };
  },
  uniformTypes: {
    base: 'f32',
    time: 'f32',
    glow: 'f32',
    enabled: 'f32',
    opacity: 'f32',
    gate: 'f32',
    severityOpacity: 'f32',
    severityLo: 'f32',
    severityHi: 'f32',
    ignitionOpacity: 'f32'
  }
} as const satisfies ShaderModule<FireModuleProps, FireUniforms, FireBindings>;

// Arrival and severity codes are categorical at the edges; the shader uses texelFetch anyway.
const nearest = {minFilter: 'nearest', magFilter: 'nearest', mipmapFilter: 'nearest'} as const;

const defaultProps: DefaultProps<FireExtensionProps> = {
  fireBase: 1,
  fireArrival: {type: 'image', value: null, async: true, parameters: nearest},
  fireTime: 0,
  fireGlow: 0.012,
  fireVisible: true,
  fireOpacity: 1,
  fireGateScar: true,
  fireSeverity: {type: 'image', value: null, async: true, parameters: nearest},
  fireSeverityOpacity: 0,
  fireSeverityRange: {type: 'array', value: [1, 255], compare: true},
  fireIgnition: {type: 'image', value: null, async: true},
  fireIgnitionOpacity: 0
};

export class FireExtension extends LayerExtension {
  static defaultProps = defaultProps;
  static extensionName = 'FireExtension';

  getShaders(): any {
    return {modules: [fireModule]};
  }

  initializeState(this: Layer<FireExtensionProps>, context: LayerContext) {
    // Every sampler must stay bound. 255 = "never burned"; 0 = no data / zero posterior.
    const pixel = (v: number) => context.device.createTexture({data: new Uint8Array([v, v, v, 255]), width: 1, height: 1});
    this.setState({fireEmpty: pixel(255), fireZero: pixel(0)});
  }

  draw(this: Layer<FireExtensionProps>) {
    const p = this.props;
    const empty = this.state.fireEmpty as Texture;
    const zero = this.state.fireZero as Texture;
    const [lo, hi] = p.fireSeverityRange ?? [1, 255];
    const props: FireModuleProps = {
      arrival: (p.fireArrival as Texture | null) ?? empty,
      severity: (p.fireSeverity as Texture | null) ?? zero,
      ignition: (p.fireIgnition as Texture | null) ?? zero,
      base: Math.min(1, Math.max(0, p.fireBase ?? 1)),
      time: p.fireTime ?? 0,
      glow: p.fireGlow ?? 0.012,
      enabled: Boolean(p.fireArrival) && p.fireVisible !== false,
      opacity: p.fireOpacity ?? 1,
      gate: p.fireGateScar !== false,
      severityOpacity: p.fireSeverity ? p.fireSeverityOpacity ?? 0 : 0,
      severityLo: lo,
      severityHi: Math.max(hi, lo + 1),
      ignitionOpacity: p.fireIgnition ? p.fireIgnitionOpacity ?? 0 : 0
    };
    this.setShaderModuleProps({fire: props});
  }

  finalizeState(this: Layer<FireExtensionProps>) {
    (this.state.fireEmpty as Texture | undefined)?.delete();
    (this.state.fireZero as Texture | undefined)?.delete();
  }
}
