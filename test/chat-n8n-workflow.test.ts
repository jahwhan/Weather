import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const wf = JSON.parse(readFileSync(new URL('../n8n/wetterflug-assistent.json', import.meta.url), 'utf8'));

interface Node {
  name: string;
  type: string;
  typeVersion: number;
  parameters: Record<string, any>;
  credentials?: Record<string, { id: string; name: string }>;
}
const nodes: Node[] = wf.nodes;
const byName = new Map(nodes.map((n) => [n.name, n]));
const byType = (t: string) => nodes.filter((n) => n.type === t);

test('Grundstruktur', () => {
  assert.ok(Array.isArray(wf.nodes) && wf.nodes.length >= 6);
  assert.equal(typeof wf.connections, 'object');
  assert.deepEqual(wf.pinData, {});
  assert.equal(wf.settings.executionOrder, 'v1');
  assert.equal(new Set(nodes.map((n) => n.name)).size, nodes.length, 'Node-Namen eindeutig');
});

test('alle Verbindungen zeigen auf existierende Nodes', () => {
  for (const [from, outputs] of Object.entries<Record<string, { node: string; type: string; index: number }[][]>>(wf.connections)) {
    assert.ok(byName.has(from), `Quelle fehlt: ${from}`);
    for (const [type, lists] of Object.entries(outputs)) {
      for (const list of lists) for (const c of list) {
        assert.ok(byName.has(c.node), `Ziel fehlt: ${c.node}`);
        assert.equal(c.type, type);
      }
    }
  }
});

test('Webhook → Agent → Antwort, mit CORS', () => {
  const [hook] = byType('n8n-nodes-base.webhook');
  assert.equal(hook.parameters.httpMethod, 'POST');
  assert.equal(hook.parameters.path, 'wetterflug-chat');
  assert.equal(hook.parameters.responseMode, 'responseNode');
  assert.equal(hook.parameters.options.allowedOrigins, 'https://jahwhan.github.io');
  const [agent] = byType('@n8n/n8n-nodes-langchain.agent');
  assert.equal(wf.connections[hook.name].main[0][0].node, agent.name);
  assert.equal(agent.parameters.promptType, 'define');
  assert.equal(agent.parameters.text, '={{ $json.body.chatInput }}');
  assert.match(agent.parameters.options.systemMessage, /JSON\.stringify\(\$json\.body\.context/);
  for (const t of ['flyTo', 'showPlace', 'setRoute', 'play', 'pause', 'setMode', 'setTime', 'showMountain', 'openWeather', 'compareModes']) {
    assert.ok(agent.parameters.options.systemMessage.includes(`"type":"${t}"`), `Aktion ${t} im Systemprompt`);
  }
  const [respond] = byType('n8n-nodes-base.respondToWebhook');
  assert.equal(wf.connections[agent.name].main[0][0].node, respond.name);
  const h = respond.parameters.options.responseHeaders.entries.find((e: { name: string }) => e.name === 'Access-Control-Allow-Origin');
  assert.equal(h.value, 'https://jahwhan.github.io');
});

test('KI-Unterknoten am Agent, kein Secret im JSON', () => {
  const agent = byType('@n8n/n8n-nodes-langchain.agent')[0].name;
  const into = (type: string) =>
    Object.entries<any>(wf.connections).filter(([, o]) => o[type]?.[0]?.[0]?.node === agent).map(([n]) => byName.get(n)!);
  const [model] = into('ai_languageModel');
  assert.equal(model.type, '@n8n/n8n-nodes-langchain.lmChatAnthropic');
  assert.equal(model.parameters.model.value, 'claude-haiku-5-5');
  assert.ok(model.credentials?.anthropicApi);
  const [mem] = into('ai_memory');
  assert.equal(mem.parameters.sessionKey, '={{ $json.body.sessionId }}');
  const tools = into('ai_tool');
  assert.equal(tools.length, 3);
  const urls = tools.map((t) => String(t.parameters.url));
  assert.ok(urls.some((u) => u.includes('api.open-meteo.com') && u.includes('elevation=') && u.includes('past_days=3')));
  assert.ok(urls.some((u) => u.includes('api3.geo.admin.ch')));
  assert.ok(urls.some((u) => u.includes('aws.slf.ch')));
  assert.equal(into('ai_outputParser').length, 1);
  const text = JSON.stringify(wf);
  assert.doesNotMatch(text, /sk-ant-|x-api-key|"apiKey"/i);
});
