// Umgebungszustand auf die Karte übertragen: Himmel, Nebel, Licht, Gelände-Schattierung,
// Satellitenbild, Nachtlichter, Strassenbeleuchtung, Wolkenschatten, Tag-Nacht-Grenze.

import type { Map as MlMap, CanvasSource, GeoJSONSource } from 'maplibre-gl';
import type { Feature } from 'geojson';
import { css, mix, scale, type Env, type RGB } from '../env';
import { clamp, lerp, smoothstep } from '../geo';
import { sunPosition } from '../astro/sun';
import { coverageThreshold, fbm, sortedCopy } from '../fx/noise';
import { ROUTE_COLOR, ROUTE_GLOW } from './style';
import { zoomBlend } from './camera';

const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

export class MapScene {
  private map: MlMap;
  private last = new Map<string, string>();
  private terminatorAt = 0;
  private shadow: CloudShadows;

  constructor(map: MlMap) {
    this.map = map;
    this.shadow = new CloudShadows(map);
  }

  private paint(layer: string, prop: string, value: unknown): void {
    const key = `${layer}|${prop}`;
    const s = JSON.stringify(value);
    if (this.last.get(key) === s) return;
    this.last.set(key, s);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.map.setPaintProperty as any)(layer, prop, value, { validate: false });
  }

  private once(key: string, value: unknown, apply: () => void): void {
    const s = JSON.stringify(value);
    if (this.last.get(key) === s) return;
    this.last.set(key, s);
    apply();
  }

  apply(env: Env): void {
    const map = this.map;
    const k = zoomBlend(map.getZoom());
    const r2 = (v: number) => Math.round(v * 100) / 100;
    const r3 = (v: number) => Math.round(v * 1000) / 1000;

    // --- Himmel und Nebel
    const fogAmount = Math.max(env.fog, env.haze * 0.55);
    const sky = {
      'sky-color': css(env.skyZenith),
      'horizon-color': css(env.skyHorizon),
      'fog-color': css(env.fogColor),
      'sky-horizon-blend': r2(lerp(0.5, 0.95, env.overcast)),
      'horizon-fog-blend': r2(lerp(0.35, 1, fogAmount)),
      'fog-ground-blend': r2(lerp(0.93, 0.02, Math.pow(fogAmount, 0.8))),
      'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 5, 1, 8, 0] as unknown as number,
    };
    this.once('sky', sky, () => map.setSky(sky));
    // Hinter der Karten-Canvas: wo zwischen Himmel und gekrümmter Erde nichts gezeichnet wird,
    // soll Horizont statt Seitenhintergrund durchscheinen
    const behind = css(mix(hex('#05070d'), mix(env.skyHorizon, env.fogColor, fogAmount), k));
    this.once('behind', behind, () => (map.getContainer().style.backgroundColor = behind));

    // --- Satellitenbild
    const exposure = env.exposure;
    const bright = lerp(1, 0.17 + 0.83 * Math.pow(exposure, 1.2), k);
    const sat = lerp(0, clamp(-0.45 * env.overcast * exposure - 0.8 * (1 - exposure) + 0.12 * env.directness, -1, 0.25), k);
    const contrast = lerp(0, clamp(0.12 * env.directness - 0.35 * env.fog - 0.12 * env.overcast + 0.1 * env.golden, -0.6, 0.3), k);
    this.paint('satellite', 'raster-brightness-max', r3(bright));
    this.paint('satellite', 'raster-saturation', r3(sat));
    this.paint('satellite', 'raster-contrast', r3(contrast));
    this.paint('tint', 'background-color', css(env.tint));
    this.paint('tint', 'background-opacity', r3(env.tintAlpha * k));
    this.paint('space', 'background-color', css(mix(hex('#05070d'), env.skyZenith, 0.25 * k)));

    // --- Nachtlichter (Satellit) und Strassenbeleuchtung
    const lightsOn = Math.pow(env.night, 1.2) * (1 - 0.55 * env.fog) * k;
    this.paint('nightlights', 'raster-opacity', [
      'interpolate',
      ['linear'],
      ['zoom'],
      4,
      0,
      6,
      r3(lightsOn * 0.95),
      11,
      r3(lightsOn * 0.85),
      14,
      r3(lightsOn * 0.25),
    ]);
    this.paint('roads-glow', 'line-opacity', [
      'interpolate',
      ['linear'],
      ['zoom'],
      9,
      r3(lightsOn * 0.35),
      13,
      r3(lightsOn * 0.6),
      16,
      r3(lightsOn * 0.75),
    ]);
    this.paint('roads', 'line-color', css(mix([255, 255, 255], hex('#ffd9a0'), env.night)));
    const dayRoad = 1 - 0.35 * env.fog;
    this.paint('roads', 'line-opacity', [
      'interpolate',
      ['linear'],
      ['zoom'],
      8,
      r3(lerp(0.12, 0.3, env.night) * dayRoad),
      12,
      r3(lerp(0.22, 0.55, env.night) * dayRoad),
      16,
      r3(lerp(0.3, 0.8, env.night) * dayRoad),
    ]);

    // --- Gelände-Schattierung nach Sonnen- oder Mondstand
    const moonLight = env.moon.altitude > 3 ? env.moon.fraction * (1 - env.cloud) : 0;
    const useMoon = env.sunAlt < -4 && moonLight > 0.15;
    const dir = useMoon ? env.moon.azimuth : env.sunAz;
    const alt = useMoon ? env.moon.altitude : env.sunAlt;
    const lowSun = 1 - smoothstep(4, 35, alt);
    let exag = useMoon
      ? 0.18 + 0.2 * moonLight
      : (0.1 + 0.3 * env.directness + 0.3 * lowSun * env.directness) * (0.35 + 0.65 * exposure);
    exag = clamp(lerp(0.3, exag, k), 0, 1);
    this.paint('hillshade', 'hillshade-illumination-direction', Math.round(dir));
    this.paint('hillshade', 'hillshade-illumination-altitude', Math.round(clamp(alt, 3, 85)));
    this.paint('hillshade', 'hillshade-exaggeration', r2(exag));
    const shadowCol = mix(hex('#081024'), env.tint, 0.25);
    this.paint('hillshade', 'hillshade-shadow-color', css(shadowCol, r2(0.45 + 0.35 * env.directness + 0.15 * lowSun)));
    this.paint('hillshade', 'hillshade-highlight-color', css(env.sunColor, r2((0.06 + 0.22 * env.directness + 0.15 * lowSun * env.directness) * exposure)));

    // --- Licht für 3D-Gebäude
    const lightAlt = useMoon ? env.moon.altitude : Math.max(env.sunAlt, -2);
    const light = {
      anchor: 'map' as const,
      position: [1.5, Math.round(dir), Math.round(clamp(90 - lightAlt, 8, 88))] as [number, number, number],
      color: css(useMoon ? hex('#9fb3e0') : env.sunColor),
      intensity: r2(useMoon ? 0.22 : 0.18 + 0.42 * env.directness),
    };
    this.once('light', light, () => map.setLight(light));
    let bcol = scale(mix(hex('#ddd6cb'), env.sunColor, 0.25 * env.golden), lerp(0.13, 1, Math.pow(exposure, 0.85)));
    bcol = mix(bcol, hex('#b08040'), 0.22 * env.night);
    bcol = mix(bcol, env.fogColor, 0.5 * env.fog);
    this.paint('buildings', 'fill-extrusion-color', css(bcol));

    // --- Wolkenschatten und Tag-Nacht-Grenze
    this.shadow.update(env, map.getZoom());
    this.updateTerminator(env.time);
  }

  /** Tag-Nacht-Grenze auf dem Globus (blendet in Bodennähe aus). */
  updateTerminator(time: number): void {
    const k = zoomBlend(this.map.getZoom());
    this.paint('terminator', 'fill-opacity', ['*', ['get', 'n'], Math.round((1 - k) * 0.72 * 1000) / 1000]);
    if (Math.abs(time - this.terminatorAt) < 120e3 || k > 0.99) return;
    this.terminatorAt = time;
    const step = 4;
    const features: Feature[] = [];
    for (let lat = -84; lat < 84; lat += step) {
      for (let lng = -180; lng < 180; lng += step) {
        const alt = sunPosition(time, lat + step / 2, lng + step / 2).altitude;
        const n = smoothstep(1, -10, alt);
        if (n < 0.01) continue;
        features.push({
          type: 'Feature',
          properties: { n: Math.round(n * 100) / 100 },
          geometry: {
            type: 'Polygon',
            coordinates: [[[lng, lat], [lng + step, lat], [lng + step, lat + step], [lng, lat + step], [lng, lat]]],
          },
        });
      }
    }
    (this.map.getSource('terminator') as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features });
  }

  /** Wachsende Spur: Anteil 0..1 in "line-progress"-Einheiten. `null` = ganze Route. */
  setRouteProgress(p: number | null): void {
    const T = 'rgba(0,0,0,0)';
    let line: unknown;
    let glow: unknown;
    if (p == null || p >= 0.9995) {
      line = ['interpolate', ['linear'], ['line-progress'], 0, ROUTE_COLOR, 1, ROUTE_COLOR];
      glow = ['interpolate', ['linear'], ['line-progress'], 0, ROUTE_GLOW, 1, ROUTE_GLOW];
    } else if (p <= 0.0005) {
      line = ['interpolate', ['linear'], ['line-progress'], 0, T, 1, T];
      glow = line;
    } else {
      const tip = Math.max(0.0001, p - 0.015);
      const e = Math.min(0.99999, p + 0.0004);
      line = ['interpolate', ['linear'], ['line-progress'], 0, ROUTE_COLOR, tip, ROUTE_COLOR, p, '#ffffff', e, T, 1, T];
      glow = ['interpolate', ['linear'], ['line-progress'], 0, ROUTE_GLOW, tip, ROUTE_GLOW, p, '#ffe3f2', e, T, 1, T];
    }
    this.paint('route-line', 'line-gradient', line);
    this.paint('route-glow', 'line-gradient', glow);
  }

  setGhostVisible(v: boolean): void {
    this.paint('route-ghost', 'line-opacity', v ? 0.75 : 0);
  }
}

/**
 * Wolkenschatten als Canvas-Quelle auf dem Gelände. Das Muster ist an die Welt geheftet
 * und zieht mit dem echten Wind (zeitgerafft), der Bedeckungsgrad entspricht der Bewölkung.
 */
class CloudShadows {
  private map: MlMap;
  private canvas = document.createElement('canvas');
  private tile = document.createElement('canvas');
  private noise: Float32Array;
  private sorted: Float32Array;
  private tileKey = '';
  private center: [number, number] = [0, 0];
  private half = 0;
  private added = false;
  private wind = { x: 0, y: 0 };
  private lastT = performance.now();
  private pattern: CanvasPattern | null = null;
  private lastOpacity = -1;
  private playing = true;

  constructor(map: MlMap) {
    this.map = map;
    this.canvas.width = this.canvas.height = 512;
    this.noise = fbm(256, 256, 4, 4, 5, 11, 0.55);
    this.sorted = sortedCopy(this.noise);
  }

  private ensure(): boolean {
    if (this.added) return true;
    if (!this.map.isStyleLoaded()) return false;
    const c = this.map.getCenter();
    this.recenter([c.lng, c.lat], 5000);
    this.map.addSource('cloudshadow', {
      type: 'canvas',
      canvas: this.canvas,
      coordinates: this.coords(),
      animate: true,
    });
    this.map.addLayer(
      { id: 'cloudshadow', type: 'raster', source: 'cloudshadow', paint: { 'raster-opacity': 0, 'raster-fade-duration': 0 } },
      'terminator',
    );
    this.added = true;
    return true;
  }

  private coords(): [[number, number], [number, number], [number, number], [number, number]] {
    const [lng, lat] = this.center;
    const dLat = this.half / 111320;
    const dLng = this.half / (111320 * Math.cos((lat * Math.PI) / 180));
    return [
      [lng - dLng, lat + dLat],
      [lng + dLng, lat + dLat],
      [lng + dLng, lat - dLat],
      [lng - dLng, lat - dLat],
    ];
  }

  private recenter(c: [number, number], half: number): void {
    this.center = c;
    this.half = half;
  }

  private buildTile(cover: number): void {
    const key = cover.toFixed(2);
    if (key === this.tileKey) return;
    this.tileKey = key;
    const t = this.tile;
    t.width = t.height = 256;
    const c = t.getContext('2d')!;
    const img = c.createImageData(256, 256);
    const th = coverageThreshold(this.sorted, cover);
    for (let i = 0; i < this.noise.length; i++) {
      const a = smoothstep(th - 0.04, th + 0.1, this.noise[i]);
      img.data[i * 4] = 6;
      img.data[i * 4 + 1] = 10;
      img.data[i * 4 + 2] = 22;
      img.data[i * 4 + 3] = 255 * a;
    }
    c.putImageData(img, 0, 0);
    this.pattern = this.canvas.getContext('2d')!.createPattern(t, 'repeat');
  }

  update(env: Env, zoom: number): void {
    if (!this.ensure()) return;
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastT) / 1000);
    this.lastT = now;

    // sichtbar bei Sonne und aufgelockerter Bewölkung
    const broken = clamp(4 * env.cloud * (1 - env.cloud) * 1.15, 0, 1);
    const sun = smoothstep(2, 12, env.sunAlt);
    const strength = sun * broken * (1 - env.fog) * clamp(0.4 + env.transmittance, 0, 1) * smoothstep(7.5, 9.5, zoom);
    const op = Math.round(strength * 0.5 * 100) / 100;
    const src = this.map.getSource('cloudshadow') as CanvasSource | undefined;
    if (op !== this.lastOpacity) {
      this.map.setPaintProperty('cloudshadow', 'raster-opacity', op, { validate: false });
      this.lastOpacity = op;
    }
    // unsichtbar: Canvas nicht jedes Bild hochladen, sonst zeichnet die Karte ständig neu
    if (op < 0.01) {
      if (this.playing) src?.pause();
      this.playing = false;
      return;
    }
    if (!this.playing) src?.play();
    this.playing = true;

    // Ausschnitt um die Kartenmitte, Grösse nach Zoom
    const c = this.map.getCenter();
    const mpp = (40075016 * Math.cos((c.lat * Math.PI) / 180)) / (512 * 2 ** zoom);
    const want = clamp(mpp * 1400, 1500, 80000);
    const dx = (c.lng - this.center[0]) * 111320 * Math.cos((c.lat * Math.PI) / 180);
    const dy = (c.lat - this.center[1]) * 111320;
    if (Math.hypot(dx, dy) > this.half * 0.3 || want / this.half > 1.6 || want / this.half < 0.6) {
      this.recenter([c.lng, c.lat], want);
      (this.map.getSource('cloudshadow') as CanvasSource | undefined)?.setCoordinates(this.coords());
    }

    this.buildTile(clamp(env.cloud, 0.05, 0.95));
    if (!this.pattern) return;

    // Wind: Wolken ziehen etwa doppelt so schnell wie der Bodenwind, 90-fach gerafft
    const toward = ((env.windDir + 180) * Math.PI) / 180;
    const speed = (env.windSpeed / 3.6) * 2 * 90;
    this.wind.x += Math.sin(toward) * speed * dt;
    this.wind.y += Math.cos(toward) * speed * dt;

    // Muster in Weltmetern verankern: eine Kachel entspricht 14 km
    const tileM = 14000;
    const size = this.canvas.width;
    const pxPerM = size / (this.half * 2);
    const worldX = this.center[0] * 111320 * Math.cos((this.center[1] * Math.PI) / 180) - this.wind.x;
    const worldY = this.center[1] * 111320 - this.wind.y;
    const s = (tileM * pxPerM) / 256;
    const ox = (-(worldX * pxPerM) % (256 * s)) + size / 2;
    const oy = ((worldY * pxPerM) % (256 * s)) + size / 2;
    const ctx = this.canvas.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, size, size);
    this.pattern.setTransform(new DOMMatrix([s, 0, 0, s, ox, oy]));
    ctx.fillStyle = this.pattern;
    ctx.fillRect(0, 0, size, size);
    // weicher Rand, damit der Ausschnitt nicht sichtbar wird
    ctx.globalCompositeOperation = 'destination-in';
    const g = ctx.createRadialGradient(size / 2, size / 2, size * 0.3, size / 2, size / 2, size * 0.5);
    g.addColorStop(0, 'rgba(0,0,0,1)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    ctx.globalCompositeOperation = 'source-over';
  }
}
