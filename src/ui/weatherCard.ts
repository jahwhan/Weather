// Wetterinstrument oben rechts: Werte an der aktuellen Position der Animation.

import { formatLux, luxLabel, type Env } from '../env';
import { sunTimes } from '../astro/sun';
import { beaufortLabel, compass, describe, okta } from '../weather/conditions';
import { SOURCE_LABEL, type WeatherSample, type WeatherSource } from '../weather/types';
import { weatherIcon } from './icons';

export interface CardContext {
  place: string;
  utcOffsetSec: number;
  source: WeatherSource;
  fetchedAt: number;
  /** true = aktuelle Analyse, false = Vorhersage */
  live: boolean;
  /** Blickrichtung der Kamera, für die Himmelsscheibe */
  cameraBearing: number;
}

const fmt1 = (v: number) => v.toFixed(1).replace('.', ',').replace(',0', '');
const fmtTemp = (v: number) => {
  const r = Math.round(v * 10) / 10;
  return (Math.abs(r) < 10 ? fmt1(r) : String(Math.round(r))).replace('-', '−');
};

export function localTime(ms: number, offsetSec: number, withDay = false): string {
  const d = new Date(ms + offsetSec * 1000);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  if (!withDay) return `${hh}:${mm}`;
  const days = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
  return `${days[d.getUTCDay()]} ${hh}:${mm}`;
}

function moonPhaseName(phase: number): string {
  if (phase < 0.03 || phase > 0.97) return 'Neumond';
  if (phase < 0.22) return 'zunehmende Sichel';
  if (phase < 0.28) return 'erstes Viertel';
  if (phase < 0.47) return 'zunehmend';
  if (phase < 0.53) return 'Vollmond';
  if (phase < 0.72) return 'abnehmend';
  if (phase < 0.78) return 'letztes Viertel';
  return 'abnehmende Sichel';
}

function formatVisibility(m: number): string {
  if (m >= 20000) return `${Math.round(m / 1000)} km`;
  if (m >= 1000) return `${(Math.round(m / 100) / 10).toString().replace('.', ',')} km`;
  return `${Math.round(m / 10) * 10} m`;
}

/** Himmelsscheibe: Rand = Horizont, Mitte = Zenit. Sonne, Mond und Blickrichtung. */
function skyDial(env: Env, cameraBearing: number): string {
  const c = 32;
  const R = 25;
  const pos = (az: number, alt: number) => {
    const r = alt >= 0 ? R * (1 - alt / 90) : R + Math.min(5, -alt / 4);
    const a = (az * Math.PI) / 180;
    return [c + r * Math.sin(a), c - r * Math.cos(a)];
  };
  const [sx, sy] = pos(env.sunAz, env.sunAlt);
  const [mx, my] = pos(env.moon.azimuth, env.moon.altitude);
  const sunUp = env.sunAlt > -0.8;
  const moonUp = env.moon.altitude > 0;
  const b = (cameraBearing * Math.PI) / 180;
  const w = 0.42;
  const wedge = `M${c} ${c} L${c + R * Math.sin(b - w)} ${c - R * Math.cos(b - w)} A${R} ${R} 0 0 1 ${c + R * Math.sin(b + w)} ${c - R * Math.cos(b + w)} Z`;
  return `<svg class="dial" viewBox="0 0 64 64" role="img" aria-label="Sonne ${Math.round(env.sunAlt)} Grad hoch, Azimut ${Math.round(env.sunAz)} Grad">
    <circle cx="${c}" cy="${c}" r="${R}" fill="rgba(255,255,255,0.04)" stroke="rgba(190,210,255,0.28)"/>
    <circle cx="${c}" cy="${c}" r="${R * (2 / 3)}" fill="none" stroke="rgba(190,210,255,0.1)"/>
    <circle cx="${c}" cy="${c}" r="${R / 3}" fill="none" stroke="rgba(190,210,255,0.1)"/>
    <path d="${wedge}" fill="rgba(255,46,147,0.22)"/>
    <text x="${c}" y="5.5" text-anchor="middle" font-size="6.5" fill="#9aa7bc" font-family="JetBrains Mono, monospace">N</text>
    ${moonUp || env.moon.altitude > -10 ? `<circle cx="${mx.toFixed(1)}" cy="${my.toFixed(1)}" r="3" fill="#e9e6d6" opacity="${moonUp ? 0.9 : 0.25}"/>` : ''}
    <circle cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="${sunUp ? 4.5 : 3.5}" fill="#ffd36b" opacity="${sunUp ? 1 : 0.3}" ${sunUp ? 'filter="drop-shadow(0 0 3px #ffb347)"' : ''}/>
  </svg>`;
}

export function renderCard(el: HTMLElement, env: Env, s: WeatherSample, ctx: CardContext): void {
  const night = env.sunAlt < -0.8;
  const cond = describe(s.code, night);
  const times = sunTimes(env.time, env.lat, env.lon);
  const precipText =
    env.precipKind === 'none' || env.precipRate < 0.05
      ? 'kein'
      : `${fmt1(env.precipRate)} mm/h ${{ rain: 'Regen', drizzle: 'Niesel', snow: 'Schnee', sleet: 'Schneeregen', hail: 'Hagel', none: '' }[env.precipKind]}`;
  const o = okta(s.cloud);
  const oktaBar = Array.from({ length: 8 }, (_, i) => `<i class="${i < o ? 'on' : ''}"></i>`).join('');
  const layers =
    s.cloudLow != null
      ? `<small>tief ${Math.round(s.cloudLow)} · mittel ${Math.round(s.cloudMid ?? 0)} · hoch ${Math.round(s.cloudHigh ?? 0)} %</small>`
      : '';
  // log. Helligkeitsskala: 0,001 lx … 100 000 lx
  const luxPos = Math.max(0, Math.min(100, ((Math.log10(env.lux) + 3) / 8) * 100));
  const sunLine =
    times.sunrise && times.sunset
      ? `<small>↑ ${localTime(times.sunrise, ctx.utcOffsetSec)} · ↓ ${localTime(times.sunset, ctx.utcOffsetSec)}</small>`
      : `<small>${env.sunAlt > 0 ? 'Polartag' : 'Polarnacht'}</small>`;
  const feels = s.feelsLike != null ? `gefühlt ${fmtTemp(s.feelsLike)}°` : '';
  const humid = s.humidity != null ? `Feuchte ${Math.round(s.humidity)} %` : '';
  const pressure = s.pressure != null ? `${Math.round(s.pressure)} hPa` : '–';
  const gust = s.windGust != null && s.windGust > s.windSpeed + 5 ? `, Böen ${Math.round(s.windGust)}` : '';

  el.innerHTML = `
    <div class="wx-place">
      <span class="wx-name" title="${escapeHtml(ctx.place)}">${escapeHtml(ctx.place)}</span>
      <span class="wx-time">${localTime(env.time, ctx.utcOffsetSec, true)} Ortszeit</span>
    </div>
    <div class="wx-main">
      ${weatherIcon(cond.icon, night)}
      <div class="wx-cond">
        <div class="wx-temp">${fmtTemp(s.temp)}<sup>°C</sup></div>
        <strong>${cond.label}</strong>
        <span>${[feels, humid].filter(Boolean).join(' · ')}</span>
      </div>
      ${skyDial(env, ctx.cameraBearing)}
    </div>
    <dl class="wx-rows">
      <dt>Licht</dt>
      <dd><b>${formatLux(env.lux)}</b> <small>${luxLabel(env.lux)}</small><span class="meter" title="Helligkeit, logarithmisch"><i style="left:${luxPos.toFixed(1)}%"></i></span></dd>
      <dt>Sonne</dt>
      <dd>${fmt1(env.sunAlt).replace('-', '−')}° hoch · ${Math.round(env.sunAz)}° ${compass(env.sunAz)} ${sunLine}</dd>
      <dt>Strahlung</dt>
      <dd>${Math.round(env.ghi)} W/m² <small>${env.ghiEstimated ? 'geschätzt' : 'Modell'} · Schatten ${Math.round(env.directness * 100)} %</small></dd>
      <dt>Wolken</dt>
      <dd><span class="okta" title="${o}/8 Okta">${oktaBar}</span> ${o}/8 ${layers}</dd>
      <dt>Sicht</dt>
      <dd>${formatVisibility(env.visibility)}${env.visibilityEstimated ? ' <small>geschätzt</small>' : ''}${env.fog > 0.5 ? ' <small>Nebel</small>' : ''}</dd>
      <dt>Nieders.</dt>
      <dd>${precipText}</dd>
      <dt>Wind</dt>
      <dd><svg class="wind-arrow" viewBox="0 0 16 16" style="transform:rotate(${Math.round(s.windDir + 180)}deg)" aria-hidden="true"><path d="M8 1l4 7H9v7H7V8H4z" fill="currentColor"/></svg>${compass(s.windDir)} ${Math.round(s.windSpeed)} km/h${gust} <small>${beaufortLabel(s.windSpeed)}</small></dd>
      <dt>Druck</dt>
      <dd>${pressure}</dd>
      <dt>Mond</dt>
      <dd>${moonPhaseName(env.moon.phase)}, ${Math.round(env.moon.fraction * 100)} % <small>${env.moon.altitude > 0 ? `${Math.round(env.moon.altitude)}° hoch` : 'unter dem Horizont'}</small></dd>
    </dl>
    <div class="wx-foot">
      <span>${ctx.live ? 'Live' : 'Prognose'} · ${SOURCE_LABEL[ctx.source]}</span>
      <span>Stand ${localTime(ctx.fetchedAt, -new Date().getTimezoneOffset() * 60)}</span>
    </div>`;
}

export function renderCardEmpty(el: HTMLElement, text: string): void {
  el.innerHTML = `<p class="wx-empty">${escapeHtml(text)}</p>`;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
