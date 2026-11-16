// Eingabe wie "Zürich bis Bern", "von Basel über Olten nach Luzern" oder "47.37, 8.54 - Bern"
// in eine Liste von Ortsangaben zerlegen.

const SEP = /\s+(bis|nach|to|über|ueber|via)\s+|\s*(?:→|->|–|—)\s*|\s+-\s+/gi;

export function parseRouteText(text: string): string[] {
  const t = text.trim().replace(/^von\s+/i, '');
  if (!t) return [];
  const parts: { text: string; via: boolean }[] = [];
  let last = 0;
  let pendingVia = false;
  for (const m of t.matchAll(SEP)) {
    parts.push({ text: t.slice(last, m.index).trim(), via: pendingVia });
    pendingVia = /^(über|ueber|via)$/i.test(m[1] ?? '');
    last = (m.index ?? 0) + m[0].length;
  }
  parts.push({ text: t.slice(last).trim(), via: pendingVia });
  const clean = parts.filter((p) => p.text.length > 0);
  if (clean.length <= 2) return clean.map((p) => p.text);

  // "über"-Orte liegen zwischen Start und Ziel, auch wenn sie am Ende stehen
  const start = clean[0];
  const rest = clean.slice(1);
  const vias = rest.filter((p) => p.via);
  const mains = rest.filter((p) => !p.via);
  if (mains.length === 0) return clean.map((p) => p.text);
  const dest = mains[mains.length - 1];
  const middle = rest.filter((p) => p !== dest);
  void vias;
  return [start, ...middle, dest].map((p) => p.text);
}

/** Text für eine Liste von Ortsnamen erzeugen. */
export function formatRouteText(names: string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} bis ${names[1]}`;
  return `${names[0]} über ${names.slice(1, -1).join(' über ')} bis ${names[names.length - 1]}`;
}
