import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateResponse, validateAction } from '../src/chat/protocol.ts';
import { askAssistant, isValidEndpoint } from '../src/chat/client.ts';
import type { AppContext } from '../src/chat/protocol.ts';

const ctx: AppContext = { place: 'Bern', route: null, playing: false, timeMode: 'live', offsetHours: 0, weatherSummary: null };
const good = { reply: 'Ich fliege nach Bern.', actions: [{ type: 'flyTo', place: 'Bern' }] };

test('validateResponse: verschiedene Hüllen', () => {
  const expect = { reply: 'Ich fliege nach Bern.', actions: [{ type: 'flyTo', place: 'Bern' }] };
  assert.deepEqual(validateResponse(good), expect);
  assert.deepEqual(validateResponse(JSON.stringify(good)), expect);
  assert.deepEqual(validateResponse({ output: JSON.stringify(good) }), expect);
  assert.deepEqual(validateResponse({ output: good }), expect);
  assert.deepEqual(validateResponse([{ output: '```json\n' + JSON.stringify(good) + '\n```' }]), expect);
  assert.deepEqual(validateResponse({ text: 'Klar! ' + JSON.stringify(good) + ' Viel Spass.' }), expect);
  assert.deepEqual(validateResponse([{ json: { output: good } }]), expect);
});

test('validateResponse: reiner Text, leere und kaputte Antworten', () => {
  assert.deepEqual(validateResponse({ output: 'Hallo, wie kann ich helfen?' }), { reply: 'Hallo, wie kann ich helfen?', actions: [] });
  assert.deepEqual(validateResponse('Nur Text'), { reply: 'Nur Text', actions: [] });
  assert.deepEqual(validateResponse(null), { reply: '', actions: [] });
  assert.deepEqual(validateResponse(42), { reply: '', actions: [] });
  assert.deepEqual(validateResponse([]), { reply: '', actions: [] });
  assert.deepEqual(validateResponse({ reply: 'ok' }), { reply: 'ok', actions: [] });
  assert.deepEqual(validateResponse({ actions: [{ type: 'play' }] }), { reply: '', actions: [{ type: 'play' }] });
});

test('validateResponse: unbekannte und ungültige Aktionen verwerfen', () => {
  const r = validateResponse({
    reply: 'x',
    actions: [
      { type: 'launchRocket' },
      { type: 'flyTo' },
      { type: 'setRoute', from: 'Zürich' },
      { type: 'setMode', mode: 'rakete' },
      { type: 'setMode', mode: 'Velo' },
      { type: 'setRoute', from: 'Zürich', to: 'Luzern', via: ['Zug', 3], mode: 'train' },
      { type: 'setTime', offsetHours: '3' },
      { type: 'setTime' },
      { type: 'flyTo', lat: 46.9, lon: 7.4, zoom: 40 },
      { type: 'showMountain', peak: 'Eiger' },
      'play',
      { type: 'compareModes', extra: 1 },
    ],
  });
  assert.deepEqual(r.actions, [
    { type: 'setMode', mode: 'bike' },
    { type: 'setRoute', from: 'Zürich', to: 'Luzern', via: ['Zug'], mode: 'transit' },
    { type: 'setTime', offsetHours: 3 },
    { type: 'flyTo', lat: 46.9, lon: 7.4, zoom: 18 },
    { type: 'showMountain', peak: 'Eiger' },
    { type: 'compareModes' },
  ]);
  assert.equal(validateAction({ type: 'flyTo', lat: 120, lon: 7 }), null);
});

test('Endpunkt-Prüfung', () => {
  assert.equal(isValidEndpoint('https://n8n.example.ch/webhook/wetterflug-chat'), true);
  assert.equal(isValidEndpoint('http://localhost:5678/webhook/x'), true);
  assert.equal(isValidEndpoint('http://example.com/x'), false);
  assert.equal(isValidEndpoint('javascript:alert(1)'), false);
});

test('askAssistant: ohne Endpunkt lokal', async () => {
  const r = await askAssistant('Flieg nach Zermatt', ctx, { endpoint: null, sessionId: 's1' });
  assert.equal(r.via, 'lokal');
  assert.deepEqual(r.actions, [{ type: 'flyTo', place: 'Zermatt' }]);
});

test('askAssistant: n8n-Antwort und Request-Format', async () => {
  let body: Record<string, unknown> = {};
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    body = JSON.parse(String(init.body));
    return new Response(JSON.stringify([{ output: JSON.stringify(good) }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  const r = await askAssistant('Zeig mir Bern', ctx, { endpoint: 'https://n8n.example.ch/webhook/wetterflug-chat', sessionId: 's1', fetchImpl, history: [{ role: 'user', text: 'Hoi' }] });
  assert.equal(r.via, 'n8n');
  assert.deepEqual(r.actions, good.actions);
  assert.equal(body.chatInput, 'Zeig mir Bern');
  assert.equal(body.sessionId, 's1');
  assert.deepEqual(body.context, ctx);
  assert.deepEqual(body.history, [{ role: 'user', text: 'Hoi' }]);
});

test('askAssistant: Fehler → lokaler Rückfall', async () => {
  const failing = (async () => new Response('Bad Gateway', { status: 502 })) as unknown as typeof fetch;
  const r = await askAssistant('Spiel ab', { ...ctx, route: { from: 'A', to: 'B', mode: 'car' } }, { endpoint: 'https://x.example/webhook', sessionId: 's', fetchImpl: failing });
  assert.equal(r.via, 'lokal');
  assert.match(r.error ?? '', /502/);
  assert.deepEqual(r.actions, [{ type: 'play' }]);
  const throwing = (async () => {
    throw new TypeError('Failed to fetch');
  }) as unknown as typeof fetch;
  const r2 = await askAssistant('Hilfe', ctx, { endpoint: 'https://x.example/webhook', sessionId: 's', fetchImpl: throwing });
  assert.equal(r2.via, 'lokal');
  const emptyRes = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
  assert.equal((await askAssistant('Hilfe', ctx, { endpoint: 'https://x.example/webhook', sessionId: 's', fetchImpl: emptyRes })).via, 'lokal');
});
