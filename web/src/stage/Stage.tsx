import {useEffect, useMemo, useState} from 'react';
import DeckGL from '@deck.gl/react';
import {LinearInterpolator, type MapViewState} from '@deck.gl/core';
import {TerrainLayer} from '@deck.gl/geo-layers';
import {PathLayer} from '@deck.gl/layers';
import {PathStyleExtension} from '@deck.gl/extensions';

import type {FireData} from '../data/fire';
import {perimeterRings} from '../data/fire';
import {useProgress} from '../state/time';
import {useUi} from '../state/ui';
import {Dem} from './dem';
import {FireExtension, type FireExtensionProps} from './fire-extension';
import {syntheticArrival} from './synthetic-arrival';
import {Compass, HoverInspector, MapControls, SyntheticChip} from './overlays';

const PITCH_3D = 58;
const fireExtension = new FireExtension();
const dashExtension = new PathStyleExtension({dash: true});
const transition = new LinearInterpolator(['pitch', 'bearing', 'zoom', 'longitude', 'latitude']);

export function Stage({fire}: {fire: FireData}) {
  const progress = useProgress();
  const {viewMode, layers, setBearing, setHover} = useUi();
  const [dem, setDem] = useState<Dem | null>(null);
  const [viewState, setViewState] = useState<MapViewState>(() => ({
    longitude: fire.aoi.center[0],
    latitude: fire.aoi.center[1] - 0.035,
    zoom: 12.3,
    pitch: PITCH_3D,
    bearing: -18,
    maxPitch: 75
  }));

  useEffect(() => {
    Dem.load(`${fire.base}/dem.png`, fire.dem).then(setDem);
  }, [fire]);

  // 2D/3D toggle eases pitch and bearing like the reference.
  useEffect(() => {
    setViewState(v => ({
      ...v,
      pitch: viewMode === '3d' ? PITCH_3D : 0,
      bearing: viewMode === '3d' ? v.bearing || -18 : 0,
      transitionDuration: 900,
      transitionInterpolator: transition
    }));
  }, [viewMode]);

  const arrival = useMemo(() => syntheticArrival(fire.perimeter, fire.dem.bounds), [fire]);

  const perimeterPaths = useMemo(() => {
    if (!dem) return [];
    return perimeterRings(fire.perimeter).map(ring =>
      ring.map(([lon, lat]) => [lon, lat, dem.heightAt(lon, lat) + 12])
    );
  }, [dem, fire]);

  const terrain = layers.terrain;
  const spread = layers.fireSpread;

  const deckLayers = [
    terrain.visible &&
      new TerrainLayer<FireExtensionProps>({
        id: 'terrain',
        elevationData: `${fire.base}/dem.png`,
        texture: `${fire.base}/base_stylized.jpg`,
        bounds: fire.dem.bounds,
        elevationDecoder: fire.dem.decoder,
        meshMaxError: 2,
        opacity: terrain.opacity ?? 1,
        material: {ambient: 0.72, diffuse: 0.4, shininess: 4, specularColor: [20, 20, 20]},
        pickable: true,
        extensions: [fireExtension],
        fireArrival: spread.visible ? arrival : null,
        fireTime: progress,
        fireGlow: 0.012
      }),
    new PathLayer<number[][], {getDashArray: [number, number]; dashJustified: boolean}>({
      id: 'final-perimeter',
      data: perimeterPaths,
      getPath: d => d as any,
      getColor: [255, 255, 255, 230],
      getWidth: 2,
      widthUnits: 'pixels',
      getDashArray: [6, 4],
      dashJustified: true,
      extensions: [dashExtension]
    })
  ];

  return (
    <div
      className="relative h-full w-full overflow-hidden"
      style={{background: 'linear-gradient(#c9cfcf 0%, #dcd8cc 45%, #d8cfbd 100%)'}}
    >
      <DeckGL
        viewState={viewState}
        onViewStateChange={({viewState: next}) => {
          setViewState(next as MapViewState);
          setBearing((next as MapViewState).bearing ?? 0);
        }}
        controller={{dragRotate: true, inertia: 300}}
        layers={deckLayers}
        onHover={info => {
          const c = info.coordinate;
          setHover(c && info.layer?.id.startsWith('terrain') ? {x: info.x, y: info.y, lon: c[0], lat: c[1]} : null);
        }}
        getCursor={({isDragging}) => (isDragging ? 'grabbing' : 'crosshair')}
      />
      <Compass
        onReset={() =>
          setViewState(v => ({...v, bearing: 0, transitionDuration: 600, transitionInterpolator: transition}))
        }
      />
      <SyntheticChip visible={spread.visible} />
      <MapControls />
      <HoverInspector dem={dem} fire={fire} />
    </div>
  );
}
