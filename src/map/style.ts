// Kartenstil: Satellitenbild, Gelände, Nachtlichter, Strassen, 3D-Gebäude, Beschriftung, Route.

import type { ExpressionSpecification, StyleSpecification } from 'maplibre-gl';
import { TERRAIN_TILES } from '../route/elevation';

export const ROUTE_COLOR = '#ff2e93';
export const ROUTE_GLOW = '#ff7cc4';

const NAME: ExpressionSpecification = ['coalesce', ['get', 'name:de'], ['get', 'name_de'], ['get', 'name']];

export function buildStyle(): StyleSpecification {
  return {
    version: 8,
    // Globus nur weit draussen; ab Zoom 8 flach, dort funktioniert auch der Geländenebel
    projection: { type: ['interpolate', ['linear'], ['zoom'], 6, 'vertical-perspective', 8, 'mercator'] },
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sky: {
      'sky-color': '#2f6fd6',
      'horizon-color': '#bcd8f2',
      'fog-color': '#d4d9df',
      'sky-horizon-blend': 0.6,
      'horizon-fog-blend': 0.6,
      'fog-ground-blend': 0.8,
      'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 5, 1, 8, 0],
    },
    light: { anchor: 'map', position: [1.5, 200, 40], color: '#ffffff', intensity: 0.4 },
    sources: {
      satellite: {
        type: 'raster',
        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
        tileSize: 256,
        maxzoom: 19,
        attribution: 'Satellitenbild © Esri, Maxar, Earthstar Geographics',
      },
      nightlights: {
        type: 'raster',
        tiles: [
          'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png',
        ],
        tileSize: 256,
        maxzoom: 8,
        attribution: 'Nachtlichter: NASA Black Marble (GIBS)',
      },
      'dem-terrain': {
        type: 'raster-dem',
        tiles: [TERRAIN_TILES],
        tileSize: 256,
        maxzoom: 15,
        encoding: 'terrarium',
        attribution: 'Gelände: Mapzen Terrain Tiles (AWS Open Data)',
      },
      'dem-shade': {
        type: 'raster-dem',
        tiles: [TERRAIN_TILES],
        tileSize: 256,
        maxzoom: 14,
        encoding: 'terrarium',
      },
      omt: {
        type: 'vector',
        url: 'https://tiles.openfreemap.org/planet',
        attribution: '<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> © <a href="https://www.openmaptiles.org/" target="_blank">OpenMapTiles</a> Daten von <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>',
      },
      terminator: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
      route: { type: 'geojson', data: { type: 'FeatureCollection', features: [] }, lineMetrics: true },
      head: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
    },
    layers: [
      { id: 'space', type: 'background', paint: { 'background-color': '#05070d' } },
      {
        id: 'satellite',
        type: 'raster',
        source: 'satellite',
        paint: { 'raster-fade-duration': 200, 'raster-resampling': 'linear' },
      },
      // Farbstich der Umgebung (Nacht, Abendlicht, Nebel, Schnee)
      { id: 'tint', type: 'background', paint: { 'background-color': '#0a1430', 'background-opacity': 0 } },
      {
        id: 'nightlights',
        type: 'raster',
        source: 'nightlights',
        minzoom: 4,
        paint: { 'raster-opacity': 0, 'raster-resampling': 'linear', 'raster-contrast': 0.3 },
      },
      {
        id: 'hillshade',
        type: 'hillshade',
        source: 'dem-shade',
        paint: {
          'hillshade-method': 'combined',
          'hillshade-illumination-anchor': 'map',
          'hillshade-illumination-direction': 200,
          'hillshade-illumination-altitude': 35,
          'hillshade-exaggeration': 0.35,
          'hillshade-shadow-color': 'rgba(8,14,32,0.9)',
          'hillshade-highlight-color': 'rgba(255,240,215,0.25)',
          'hillshade-accent-color': 'rgba(0,0,0,0.1)',
        },
      },
      {
        id: 'terminator',
        type: 'fill',
        source: 'terminator',
        maxzoom: 8,
        paint: { 'fill-color': '#030714', 'fill-opacity': ['*', ['get', 'n'], 0.7], 'fill-antialias': false },
      },
      {
        id: 'roads-glow',
        type: 'line',
        source: 'omt',
        'source-layer': 'transportation',
        minzoom: 9,
        filter: ['match', ['get', 'class'], ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor'], true, false],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#ffb24d',
          'line-blur': ['interpolate', ['linear'], ['zoom'], 9, 2, 16, 10],
          'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 9, 1.5, 13, 4, 17, 22],
          'line-opacity': 0,
        },
      },
      {
        id: 'roads',
        type: 'line',
        source: 'omt',
        'source-layer': 'transportation',
        minzoom: 8,
        filter: ['match', ['get', 'class'], ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor'], true, false],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#ffffff',
          'line-width': [
            'interpolate',
            ['exponential', 1.6],
            ['zoom'],
            8,
            ['match', ['get', 'class'], ['motorway', 'trunk'], 0.9, 0.3],
            13,
            ['match', ['get', 'class'], ['motorway', 'trunk'], 2.2, ['primary', 'secondary'], 1.4, 0.6],
            17,
            ['match', ['get', 'class'], ['motorway', 'trunk'], 9, ['primary', 'secondary'], 7, 3.5],
          ],
          'line-opacity': ['interpolate', ['linear'], ['zoom'], 8, 0.12, 12, 0.22, 16, 0.3],
        },
      },
      {
        id: 'buildings',
        type: 'fill-extrusion',
        source: 'omt',
        'source-layer': 'building',
        minzoom: 13,
        paint: {
          'fill-extrusion-color': '#d8d2c8',
          'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 8],
          'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
          'fill-extrusion-opacity': ['interpolate', ['linear'], ['zoom'], 13, 0, 14.5, 0.88],
          'fill-extrusion-vertical-gradient': true,
        },
      },
      {
        id: 'route-casing',
        type: 'line',
        source: 'route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#000000',
          'line-opacity': 0.35,
          'line-blur': 3,
          'line-width': ['interpolate', ['linear'], ['zoom'], 4, 4, 12, 9, 16, 16],
        },
      },
      {
        id: 'route-ghost',
        type: 'line',
        source: 'route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#ffffff',
          'line-opacity': 0.75,
          'line-dasharray': [1.2, 1.4],
          'line-width': ['interpolate', ['linear'], ['zoom'], 4, 1.5, 12, 3, 16, 5],
        },
      },
      {
        id: 'route-glow',
        type: 'line',
        source: 'route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-width': ['interpolate', ['linear'], ['zoom'], 4, 8, 12, 16, 16, 28],
          'line-blur': ['interpolate', ['linear'], ['zoom'], 4, 6, 12, 10, 16, 16],
          'line-opacity': 0.55,
          'line-gradient': ['interpolate', ['linear'], ['line-progress'], 0, ROUTE_GLOW, 1, ROUTE_GLOW],
        },
      },
      {
        id: 'route-line',
        type: 'line',
        source: 'route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-width': ['interpolate', ['linear'], ['zoom'], 4, 2.5, 12, 5, 16, 8],
          'line-gradient': ['interpolate', ['linear'], ['line-progress'], 0, ROUTE_COLOR, 1, ROUTE_COLOR],
        },
      },
      {
        id: 'head-glow',
        type: 'circle',
        source: 'head',
        paint: {
          'circle-radius': 22,
          'circle-blur': 1,
          'circle-color': ROUTE_GLOW,
          'circle-opacity': 0.75,
          'circle-pitch-alignment': 'viewport',
        },
      },
      {
        id: 'head-core',
        type: 'circle',
        source: 'head',
        paint: {
          'circle-radius': 6.5,
          'circle-color': '#ffffff',
          'circle-stroke-color': ROUTE_COLOR,
          'circle-stroke-width': 4,
          'circle-pitch-alignment': 'viewport',
        },
      },
      {
        id: 'peaks',
        type: 'symbol',
        source: 'omt',
        'source-layer': 'mountain_peak',
        minzoom: 10,
        filter: ['has', 'ele'],
        layout: {
          'text-field': ['concat', NAME, '\n', ['to-string', ['get', 'ele']], ' m'],
          'text-font': ['Noto Sans Regular'],
          'text-size': 11,
          'text-offset': [0, 0.6],
          'text-anchor': 'top',
          'symbol-sort-key': ['-', 0, ['coalesce', ['get', 'ele'], 0]],
        },
        paint: {
          'text-color': '#f4f1ea',
          'text-halo-color': 'rgba(10,14,24,0.85)',
          'text-halo-width': 1.4,
        },
      },
      {
        id: 'places-minor',
        type: 'symbol',
        source: 'omt',
        'source-layer': 'place',
        minzoom: 10,
        filter: ['match', ['get', 'class'], ['village', 'suburb', 'hamlet'], true, false],
        layout: {
          'text-field': NAME,
          'text-font': ['Noto Sans Regular'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 10, 10, 15, 13],
        },
        paint: {
          'text-color': '#ffffff',
          'text-halo-color': 'rgba(10,14,24,0.8)',
          'text-halo-width': 1.3,
        },
      },
      {
        id: 'places',
        type: 'symbol',
        source: 'omt',
        'source-layer': 'place',
        filter: ['match', ['get', 'class'], ['city', 'town'], true, false],
        layout: {
          'text-field': NAME,
          'text-font': ['Noto Sans Bold'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 4, ['match', ['get', 'class'], 'city', 11, 9], 12, ['match', ['get', 'class'], 'city', 18, 14]],
          'symbol-sort-key': ['coalesce', ['get', 'rank'], 99],
        },
        paint: {
          'text-color': '#ffffff',
          'text-halo-color': 'rgba(10,14,24,0.85)',
          'text-halo-width': 1.6,
        },
      },
      {
        id: 'countries',
        type: 'symbol',
        source: 'omt',
        'source-layer': 'place',
        maxzoom: 6,
        filter: ['==', ['get', 'class'], 'country'],
        layout: {
          'text-field': NAME,
          'text-font': ['Noto Sans Bold'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 1, 10, 5, 15],
          'text-transform': 'uppercase',
          'text-letter-spacing': 0.15,
        },
        paint: {
          'text-color': 'rgba(255,255,255,0.85)',
          'text-halo-color': 'rgba(10,14,24,0.7)',
          'text-halo-width': 1.2,
        },
      },
    ],
  };
}
