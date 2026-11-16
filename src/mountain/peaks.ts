// Gipfel: die Schweizer 4000er und beliebte Ziele. Koordinaten WGS84 aus dem
// swisstopo-Gazetteer (geo.admin SearchServer), Höhen nach Landeskarte.

export interface Peak {
  id: string;
  name: string;
  /** Höhe in m ü. M. */
  elevation: number;
  lat: number;
  lon: number;
  aliases: string[];
  /** Kanton bzw. Gebiet */
  region?: string;
  is4000: boolean;
}

type Row = [id: string, name: string, elevation: number, lat: number, lon: number, region: string, aliases?: string[]];

const FOUR_THOUSANDERS: Row[] = [
  ['dufourspitze', 'Dufourspitze', 4634, 45.9369, 7.8668, 'VS', ['Monte Rosa', 'Pointe Dufour', 'Punta Dufour']],
  ['nordend', 'Nordend', 4609, 45.942, 7.8699, 'VS'],
  ['zumsteinspitze', 'Zumsteinspitze', 4563, 45.9322, 7.8714, 'VS', ['Punta Zumstein']],
  ['signalkuppe', 'Signalkuppe', 4554, 45.9272, 7.8771, 'VS', ['Punta Gnifetti', 'Capanna Margherita']],
  ['dom', 'Dom', 4545, 46.0939, 7.8589, 'VS', ['Dom Mischabel']],
  ['liskamm-ost', 'Liskamm (Ostgipfel)', 4527, 45.9225, 7.8356, 'VS', ['Liskamm', 'Lyskamm', 'Liskamm Ost', 'Lyskamm Ost']],
  ['weisshorn', 'Weisshorn', 4506, 46.1012, 7.7161, 'VS'],
  ['taeschhorn', 'Täschhorn', 4491, 46.0834, 7.8572, 'VS'],
  ['liskamm-west', 'Liskamm (Westgipfel)', 4479, 45.9265, 7.8234, 'VS', ['Liskamm West', 'Lyskamm West']],
  ['matterhorn', 'Matterhorn', 4478, 45.9764, 7.6586, 'VS', ['Cervin', 'Mont Cervin', 'Monte Cervino', 'Horu']],
  ['parrotspitze', 'Parrotspitze', 4432, 45.9198, 7.8709, 'VS', ['Punta Parrot']],
  ['dent-blanche', 'Dent Blanche', 4357, 46.0342, 7.6119, 'VS'],
  ['ludwigshoehe', 'Ludwigshöhe', 4341, 45.9167, 7.8635, 'VS'],
  ['nadelhorn', 'Nadelhorn', 4327, 46.1089, 7.8641, 'VS'],
  ['grand-combin', 'Grand Combin de Grafeneire', 4314, 45.9376, 7.2992, 'VS', ['Grand Combin', 'Combin de Grafeneire']],
  ['lenzspitze', 'Lenzspitze', 4294, 46.1045, 7.8686, 'VS'],
  ['finsteraarhorn', 'Finsteraarhorn', 4274, 46.5374, 8.1261, 'BE/VS'],
  ['stecknadelhorn', 'Stecknadelhorn', 4241, 46.1115, 7.8595, 'VS'],
  ['castor', 'Castor', 4228, 45.9208, 7.7932, 'VS', ['Punta Castore']],
  ['zinalrothorn', 'Zinalrothorn', 4221, 46.0648, 7.6901, 'VS'],
  ['hohberghorn', 'Hohberghorn', 4219, 46.1126, 7.8538, 'VS'],
  ['alphubel', 'Alphubel', 4206, 46.0629, 7.8639, 'VS'],
  ['rimpfischhorn', 'Rimpfischhorn', 4199, 46.0231, 7.8839, 'VS'],
  ['aletschhorn', 'Aletschhorn', 4193, 46.4652, 7.9936, 'VS'],
  ['strahlhorn', 'Strahlhorn', 4190, 46.0132, 7.902, 'VS'],
  ['combin-de-valsorey', 'Combin de Valsorey', 4184, 45.938, 7.2903, 'VS', ['Grand Combin de Valsorey']],
  ['dent-d-herens', "Dent d'Hérens", 4174, 45.97, 7.605, 'VS', ['Dent d Herens']],
  ['breithorn', 'Breithorn', 4164, 45.941, 7.7477, 'VS', ['Breithorn Westgipfel', 'Zermatter Breithorn']],
  ['jungfrau', 'Jungfrau', 4158, 46.5368, 7.9626, 'BE/VS'],
  ['bishorn', 'Bishorn', 4153, 46.1179, 7.7149, 'VS'],
  ['combin-de-la-tsessette', 'Combin de la Tsessette', 4141, 45.9429, 7.3111, 'VS', ['Grand Combin de la Tsessette']],
  ['moench', 'Mönch', 4110, 46.5585, 7.9973, 'BE/VS'],
  ['pollux', 'Pollux', 4092, 45.9278, 7.7853, 'VS', ['Punta Polluce']],
  ['roccia-nera', 'Roccia Nera', 4075, 45.9327, 7.7751, 'VS', ['Schwarzfluh']],
  ['schreckhorn', 'Schreckhorn', 4078, 46.5899, 8.1181, 'BE'],
  ['ober-gabelhorn', 'Ober Gabelhorn', 4063, 46.0385, 7.668, 'VS', ['Obergabelhorn']],
  ['gross-fiescherhorn', 'Gross Fiescherhorn', 4049, 46.5513, 8.0615, 'BE/VS', ['Grosses Fiescherhorn', 'Fiescherhorn']],
  ['piz-bernina', 'Piz Bernina', 4049, 46.3824, 9.9081, 'GR', ['Bernina']],
  ['gross-gruenhorn', 'Gross Grünhorn', 4044, 46.532, 8.0777, 'VS', ['Grosses Grünhorn', 'Grünhorn']],
  ['lauteraarhorn', 'Lauteraarhorn', 4042, 46.5833, 8.1284, 'BE'],
  ['duerrenhorn', 'Dürrenhorn', 4035, 46.1197, 7.8482, 'VS', ['Dirruhorn']],
  ['allalinhorn', 'Allalinhorn', 4027, 46.0461, 7.8946, 'VS', ['Allalin']],
  ['hinter-fiescherhorn', 'Hinter Fiescherhorn', 4025, 46.5463, 8.0677, 'VS', ['Hinteres Fiescherhorn']],
  ['weissmies', 'Weissmies', 4017, 46.1277, 8.012, 'VS'],
  ['lagginhorn', 'Lagginhorn', 4010, 46.1571, 8.0031, 'VS'],
];

const POPULAR: Row[] = [
  ['eiger', 'Eiger', 3967, 46.5776, 8.0053, 'BE'],
  ['piz-roseg', 'Piz Roseg', 3937, 46.3736, 9.8829, 'GR'],
  ['bietschhorn', 'Bietschhorn', 3934, 46.3916, 7.8508, 'VS'],
  ['piz-palue', 'Piz Palü', 3901, 46.3788, 9.9602, 'GR', ['Palü']],
  ['klein-matterhorn', 'Klein Matterhorn', 3883, 45.9384, 7.7299, 'VS', ['Matterhorn Glacier Paradise']],
  ['piz-morteratsch', 'Piz Morteratsch', 3751, 46.4025, 9.9015, 'GR'],
  ['mont-velan', 'Mont Vélan', 3727, 45.8926, 7.2507, 'VS'],
  ['balmhorn', 'Balmhorn', 3698, 46.4247, 7.6936, 'BE/VS'],
  ['wetterhorn', 'Wetterhorn', 3692, 46.6387, 8.1155, 'BE', ['Hasli Jungfrau']],
  ['bluemlisalp', 'Blüemlisalphorn', 3661, 46.4888, 7.7718, 'BE', ['Blüemlisalp', 'Blüemlisalphorn']],
  ['doldenhorn', 'Doldenhorn', 3638, 46.4685, 7.7349, 'BE'],
  ['dammastock', 'Dammastock', 3630, 46.6435, 8.4211, 'UR/VS'],
  ['toedi', 'Tödi', 3614, 46.8112, 8.9146, 'GL/GR', ['Piz Russein', 'Tödi Piz Russein']],
  ['galenstock', 'Galenstock', 3586, 46.6126, 8.417, 'UR/VS'],
  ['sustenhorn', 'Sustenhorn', 3503, 46.6989, 8.4551, 'BE/UR'],
  ['piz-corvatsch', 'Piz Corvatsch', 3451, 46.4083, 9.8161, 'GR', ['Corvatsch']],
  ['gspaltenhorn', 'Gspaltenhorn', 3436, 46.5116, 7.8273, 'BE'],
  ['piz-kesch', 'Piz Kesch', 3418, 46.6213, 9.8728, 'GR', ["Piz d'Es-cha", 'Kesch']],
  ['piz-linard', 'Piz Linard', 3411, 46.7989, 10.0714, 'GR', ['Linard']],
  ['piz-julier', 'Piz Julier', 3380, 46.491, 9.7599, 'GR', ['Piz Güglia']],
  ['oberalpstock', 'Oberalpstock', 3328, 46.7427, 8.7695, 'GR/UR', ['Piz Tgietschen']],
  ['piz-buin', 'Piz Buin', 3312, 46.8441, 10.1189, 'GR', ['Piz Buin Grond', 'Grosser Piz Buin']],
  ['gross-schaerhorn', 'Gross Schärhorn', 3295, 46.827, 8.8295, 'UR', ['Schärhorn']],
  ['dents-du-midi', 'Dents du Midi (Haute Cime)', 3257, 46.1611, 6.9232, 'VS', ['Dents du Midi', 'Haute Cime']],
  ['wildhorn', 'Wildhorn', 3248, 46.3548, 7.3608, 'BE/VS'],
  ['wildstrubel', 'Wildstrubel', 3244, 46.4003, 7.5286, 'BE/VS'],
  ['titlis', 'Titlis', 3238, 46.772, 8.4378, 'BE/OW'],
  ['diablerets', 'Les Diablerets', 3210, 46.3044, 7.1904, 'VD/VS', ['Diablerets', 'Sommet des Diablerets', 'Glacier 3000']],
  ['gornergrat', 'Gornergrat', 3135, 45.9832, 7.7845, 'VS'],
  ['piz-nair', 'Piz Nair', 3057, 46.5064, 9.7873, 'GR'],
  ['grand-muveran', 'Grand Muveran', 3051, 46.2372, 7.1262, 'VD/VS', ['Muveran']],
  ['schilthorn', 'Schilthorn', 2970, 46.5573, 7.8349, 'BE', ['Piz Gloria']],
  ['glaernisch', 'Glärnisch (Vrenelisgärtli)', 2904, 47.0078, 9.0169, 'GL', ['Glärnisch', 'Vrenelisgärtli', 'Vreneli']],
  ['pizol', 'Pizol', 2844, 46.9592, 9.3867, 'SG'],
  ['weissfluh', 'Weissfluh', 2844, 46.8353, 9.7941, 'GR', ['Weissfluhgipfel']],
  ['faulhorn', 'Faulhorn', 2681, 46.6748, 7.9991, 'BE'],
  ['saentis', 'Säntis', 2502, 47.2494, 9.3432, 'AI/AR/SG'],
  ['brisen', 'Brisen', 2404, 46.8988, 8.4583, 'NW/UR'],
  ['niesen', 'Niesen', 2362, 46.6462, 7.6524, 'BE'],
  ['brienzer-rothorn', 'Brienzer Rothorn', 2350, 46.7871, 8.0469, 'BE/LU/OW', ['Rothorn Brienz']],
  ['maennlichen', 'Männlichen', 2342, 46.6182, 7.9381, 'BE'],
  ['chaeserrugg', 'Chäserrugg', 2262, 47.1548, 9.3123, 'SG'],
  ['stockhorn', 'Stockhorn', 2190, 46.694, 7.5373, 'BE'],
  ['gantrisch', 'Gantrisch', 2175, 46.7048, 7.4506, 'BE'],
  ['pilatus', 'Pilatus (Tomlishorn)', 2128, 46.9739, 8.2412, 'LU/NW/OW', ['Pilatus', 'Tomlishorn', 'Pilatus Kulm', 'Esel']],
  ['rochers-de-naye', 'Rochers de Naye', 2042, 46.4318, 6.976, 'VD'],
  ['moleson', 'Moléson', 2002, 46.5488, 7.0171, 'FR', ['Le Moléson']],
  ['niederhorn', 'Niederhorn', 1963, 46.7117, 7.7768, 'BE'],
  ['monte-tamaro', 'Monte Tamaro', 1962, 46.1039, 8.866, 'TI', ['Tamaro']],
  ['speer', 'Speer', 1950, 47.1858, 9.1228, 'SG'],
  ['fronalpstock', 'Fronalpstock', 1921, 46.9682, 8.6373, 'SZ'],
  ['grosser-mythen', 'Grosser Mythen', 1899, 47.0299, 8.6888, 'SZ', ['Gross Mythen', 'Mythen']],
  ['stanserhorn', 'Stanserhorn', 1898, 46.9297, 8.3403, 'NW'],
  ['rigi', 'Rigi Kulm', 1798, 47.0568, 8.4853, 'SZ', ['Rigi']],
  ['hoher-kasten', 'Hoher Kasten', 1794, 47.2837, 9.485, 'AI/SG'],
  ['monte-generoso', 'Monte Generoso', 1701, 45.9313, 9.02, 'TI', ['Generoso']],
  ['chasseral', 'Chasseral', 1607, 47.1331, 7.0594, 'BE'],
  ['napf', 'Napf', 1408, 47.0036, 7.94, 'BE/LU'],
  ['san-salvatore', 'Monte San Salvatore', 912, 45.9769, 8.9473, 'TI', ['San Salvatore']],
  ['uetliberg', 'Uetliberg', 870, 47.3495, 8.492, 'ZH', ['Uto Kulm', 'Üetliberg', 'Ütliberg']],
];

function toPeak(r: Row, is4000: boolean): Peak {
  return { id: r[0], name: r[1], elevation: r[2], lat: r[3], lon: r[4], region: r[5], aliases: r[6] ?? [], is4000 };
}

export const PEAKS: Peak[] = [...FOUR_THOUSANDERS.map((r) => toPeak(r, true)), ...POPULAR.map((r) => toPeak(r, false))];

/** Kleinbuchstaben, ohne Akzente, ä/ae → a usw., nur Buchstaben/Ziffern mit einfachen Leerzeichen. */
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ae/g, 'a')
    .replace(/oe/g, 'o')
    .replace(/ue/g, 'u')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Genitiv/Plural-s am Wortende weg ("Matterhorns", "Pilatus" → beides gleich behandeln). */
function stripS(s: string): string {
  return s
    .split(' ')
    .map((w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w))
    .join(' ');
}

interface Key {
  key: string;
  peak: Peak;
}
let index: Key[] | null = null;
function keys(): Key[] {
  if (index) return index;
  index = [];
  for (const p of PEAKS) {
    const names = new Set([p.name, p.name.replace(/\s*\(.*\)\s*/, ' '), ...p.aliases]);
    for (const n of names) {
      const k = normalize(n);
      if (k) index.push({ key: k, peak: p });
    }
  }
  // längere Namen zuerst ("Klein Matterhorn" vor "Matterhorn")
  index.sort((a, b) => b.key.length - a.key.length);
  return index;
}

/** Bekannten Gipfel in einem freien Text finden ("Kann ich aufs Matterhorn?"). */
export function findPeak(text: string): Peak | null {
  const t = normalize(text);
  if (!t) return null;
  const padded = ` ${t} `;
  for (const k of keys()) if (padded.includes(` ${k.key} `)) return k.peak;
  const ts = ` ${stripS(t)} `;
  for (const k of keys()) if (ts.includes(` ${stripS(k.key)} `)) return k.peak;
  return null;
}

/** Füllwörter entfernen, um aus einer Frage den Gipfelnamen für die Suche zu gewinnen. */
export function peakQuery(text: string): string {
  return text
    .replace(/[?!.]+/g, ' ')
    .replace(
      /\b(kann|könnte|koennte|darf|soll|sollte|ich|man|wir|heute|morgen|übermorgen|uebermorgen|aufs|auf|uf|den|die|das|dem|der|am|zum|zur|bergwetter|verhältnisse|verhaeltnisse|wetter|wie|sind|ist|isch|gipfel|besteigen|steigen|gehen|go|tour|hochtour|bergtour|wandern|hoch|rauf|in|im|für|fuer|bitte|zeig|mir|mal)\b/gi,
      ' ',
    )
    .replace(/\s+/g, ' ')
    .trim();
}

/** WGS84 → LV95 (Näherungsformeln swisstopo, ~1 m genau). */
export function wgs84ToLv95(lat: number, lon: number): [number, number] {
  const p = (lat * 3600 - 169028.66) / 10000;
  const l = (lon * 3600 - 26782.5) / 10000;
  const e = 2600072.37 + 211455.93 * l - 10938.51 * l * p - 0.36 * l * p * p - 44.54 * l * l * l;
  const n = 1200147.07 + 308807.95 * p + 3745.25 * l * l + 76.63 * p * p - 194.56 * l * l * p + 119.79 * p * p * p;
  return [e, n];
}

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const t = AbortSignal.timeout(ms);
  if (!signal) return t;
  return typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, t]) : signal;
}

interface SearchResult {
  id?: number | string;
  attrs: { label: string; lat: number; lon: number; detail?: string; objectclass?: string };
}

const PEAK_LABEL = /peak|hill|gipfel|h(?:ue|ü)gel|sommet|cima/i;

/** Gipfel finden: zuerst die eigene Liste, sonst swisstopo-Gazetteer (nur Gipfel/Hügel). */
export async function searchPeak(text: string, signal?: AbortSignal): Promise<Peak | null> {
  const known = findPeak(text);
  if (known) return known;
  const q = peakQuery(text) || text.trim();
  if (!q) return null;
  const params = new URLSearchParams({ searchText: q, type: 'locations', sr: '4326', origins: 'gazetteer', limit: '30' });
  const res = await fetch(`https://api3.geo.admin.ch/rest/services/api/SearchServer?${params}`, { signal: withTimeout(signal, 8000) });
  if (!res.ok) return null;
  const json = (await res.json()) as { results?: SearchResult[] };
  const hit = (json.results ?? []).find((r) => PEAK_LABEL.test(r.attrs.label));
  if (!hit) return null;
  const bold = /<b>(.*?)<\/b>/.exec(hit.attrs.label);
  const name = (bold ? bold[1] : hit.attrs.label.replace(/<[^>]+>/g, '')).split('|')[0].trim();
  const { lat, lon } = hit.attrs;
  let elevation: number | null = null;
  const fromDetail = /(\d{3,4})\s*m\b/.exec(hit.attrs.detail ?? '');
  if (fromDetail) elevation = Number(fromDetail[1]);
  if (elevation == null) {
    try {
      const [e, n] = wgs84ToLv95(lat, lon);
      const h = await fetch(`https://api3.geo.admin.ch/rest/services/height?easting=${e.toFixed(1)}&northing=${n.toFixed(1)}&sr=2056`, {
        signal: withTimeout(signal, 6000),
      });
      if (h.ok) {
        const v = parseFloat(((await h.json()) as { height?: string }).height ?? '');
        if (Number.isFinite(v)) elevation = Math.round(v);
      }
    } catch {
      /* Höhe bleibt unbekannt */
    }
  }
  if (elevation == null) return null;
  return { id: `geo:${hit.id ?? name}`, name, elevation, lat, lon, aliases: [], is4000: elevation >= 4000 };
}
