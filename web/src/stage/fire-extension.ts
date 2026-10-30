/**
 * Render path A (BUILD.md §3): the fire lives in the terrain mesh's own fragment shader.
 *
 * The arrival texture's red channel encodes when each cell burned, relative to
 * aoi.window_utc: 1..254 → arrival (code − 1) / 253 in [0, 1], 255 → never burned
 * (same contract as pipeline step 06, BUILD.md §3). At replay time t:
 *   t < arrival                  unburned (base texture)
 *   0 ≤ t − arrival ≤ glow       active front (emissive orange-yellow)
 *   t − arrival > glow           charred, with embers fading out
 *
 * Pass it to a TerrainLayer: extensions are forwarded to the mesh sublayer, and the
 * arrival image is sampled with the same UVs as the base texture, so both stay aligned.
 */
import {LayerExtension} from '@deck.gl/core';
import type {DefaultProps, Layer, LayerContext} from '@deck.gl/core';
import type {Texture} from '@luma.gl/core';
import type {ShaderModule} from '@luma.gl/shadertools';

export type FireExtensionProps = {
  /** Arrival-time image (URL, canvas or texture). Null disables the effect. */
  fireArrival?: unknown;
  /** Replay position in [0, 1]. */
  fireTime?: number;
  /** Width of the glowing front, in the same normalized units. */
  fireGlow?: number;
};

type FireModuleProps = {arrival: Texture; time: number; glow: number; enabled: boolean};
type FireUniforms = {time: number; glow: number; enabled: number};
type FireBindings = {fire_arrival: Texture};

const fs = /* glsl */ `\
layout(std140) uniform fireUniforms {
  float time;
  float glow;
  float enabled;
} fire;

uniform sampler2D fire_arrival;

float fire_hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}
`;

const inject = {
  'fs:DECKGL_FILTER_COLOR': /* glsl */ `
  if (fire.enabled > 0.5) {
    float code = texture(fire_arrival, geometry.uv).r * 255.0;
    if (code < 254.5) {
      float arrival = (code - 1.0) / 253.0;
      float since = fire.time - arrival;
      if (since >= 0.0) {
        float front = 1.0 - smoothstep(0.0, fire.glow, since);
        float speck = step(0.955, fire_hash(floor(geometry.uv * 1400.0)));
        float embers = speck * (1.0 - smoothstep(0.0, fire.glow * 8.0, since));
        vec3 charred = mix(color.rgb * 0.38, vec3(0.20, 0.17, 0.14), 0.6);
        charred = mix(charred, vec3(0.98, 0.38, 0.08), embers * 0.85);
        vec3 flame = mix(vec3(1.0, 0.45, 0.08), vec3(1.0, 0.86, 0.52), front * front);
        color.rgb = mix(charred, flame * 1.6, front);
      }
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
    return {fire_arrival: opts.arrival, time: opts.time, glow: opts.glow, enabled: opts.enabled ? 1 : 0};
  },
  uniformTypes: {time: 'f32', glow: 'f32', enabled: 'f32'}
} as const satisfies ShaderModule<FireModuleProps, FireUniforms, FireBindings>;

const defaultProps: DefaultProps<FireExtensionProps> = {
  fireArrival: {type: 'image', value: null, async: true},
  fireTime: 0,
  fireGlow: 0.012
};

export class FireExtension extends LayerExtension {
  static defaultProps = defaultProps;
  static extensionName = 'FireExtension';

  getShaders(): any {
    return {modules: [fireModule]};
  }

  initializeState(this: Layer<FireExtensionProps>, context: LayerContext) {
    // 255 = "never burned", so an unset arrival image leaves the terrain untouched.
    this.setState({fireEmpty: context.device.createTexture({data: new Uint8Array([255, 255, 255, 255]), width: 1, height: 1})});
  }

  draw(this: Layer<FireExtensionProps>) {
    const {fireArrival, fireTime = 0, fireGlow = 0.012} = this.props;
    const props: FireModuleProps = {
      arrival: (fireArrival as Texture | null) ?? (this.state.fireEmpty as Texture),
      time: fireTime,
      glow: fireGlow,
      enabled: Boolean(fireArrival)
    };
    this.setShaderModuleProps({fire: props});
  }

  finalizeState(this: Layer<FireExtensionProps>) {
    (this.state.fireEmpty as Texture | undefined)?.delete();
  }
}
