# Wetterflug-Assistent mit n8n

Der Chat in Wetterflug funktioniert ohne Server: Ein lokaler Intent-Parser versteht die wichtigsten Befehle direkt im Browser. Mit diesem n8n-Workflow beantwortet stattdessen ein Sprachmodell (Anthropic, `claude-haiku-5-5`) die Fragen und steuert die App über dasselbe Aktionsprotokoll. Fällt n8n aus, springt automatisch wieder der lokale Assistent ein.

## Aufbau

```
Webhook (POST /webhook/wetterflug-chat, CORS: https://jahwhan.github.io)
  → AI Agent  ── Anthropic Chat Model (claude-haiku-5-5)
     │         ── Chat-Gedächtnis (Window Buffer, Schlüssel = sessionId, 10 Nachrichten)
     │         ── Tools: Gipfelwetter (Open-Meteo), Ortssuche (geo.admin), SLF-Lawinenbulletin
     │         ── JSON-Antwort (Structured Output Parser: {reply, actions})
  → Respond to Webhook (JSON, Access-Control-Allow-Origin)
```

## Einrichten

1. **Importieren:** In n8n *Workflows → Import from File* und `wetterflug-assistent.json` wählen.
2. **Anthropic-Credential anlegen:** *Credentials → New → Anthropic*, API-Key eintragen. Danach im Node *Anthropic Chat Model* dieses Credential auswählen (im JSON steht nur ein Platzhalter, kein Schlüssel).
3. **Herkunft prüfen:** Im Webhook-Node steht unter *Options → Allowed Origins (CORS)* `https://jahwhan.github.io`. Für lokale Tests zusätzlich z. B. `http://localhost:5173` eintragen (kommagetrennt). Den gleichen Wert ggf. im Header des Nodes *Antwort senden* anpassen.
4. **Aktivieren:** Workflow speichern und oben rechts auf *Active* stellen.
5. **Produktions-URL kopieren:** Im Webhook-Node unter *Production URL*, z. B. `https://n8n.example.ch/webhook/wetterflug-chat`.
6. **In der App eintragen** – eine der beiden Varianten:
   - im Chat auf das Zahnrad tippen, URL einfügen, *Speichern* (wird im Browser unter `wetterflug.n8nUrl` gespeichert), oder
   - beim Build als Umgebungsvariable setzen: `VITE_N8N_CHAT_URL=https://…/webhook/wetterflug-chat`. Bei GitHub Pages: *Settings → Secrets and variables → Actions → Variables* eine Variable `VITE_N8N_CHAT_URL` anlegen und im Build-Schritt als `env: VITE_N8N_CHAT_URL: ${{ vars.VITE_N8N_CHAT_URL }}` durchreichen.

Die Statuszeile im Chat zeigt „n8n verbunden“, „n8n nicht erreichbar – lokal“ oder „Lokaler Assistent“.

### CORS und Preflight

Die App sendet `Content-Type: application/json`; der Browser schickt deshalb zuerst eine `OPTIONS`-Anfrage. Der Webhook-Node (ab Version 2) beantwortet diesen Preflight selbst, sobald *Allowed Origins* gesetzt ist – ein zweiter Pfad ist nicht nötig. Liegt n8n hinter einem Reverse-Proxy, darf dieser `OPTIONS` nicht blockieren. Bei sehr alten n8n-Versionen ohne diese Option: einen zweiten Webhook-Node mit Methode `OPTIONS` und gleichem Pfad anlegen, der mit leerem Body und den Headern `Access-Control-Allow-Origin`, `Access-Control-Allow-Methods: POST, OPTIONS` und `Access-Control-Allow-Headers: Content-Type` antwortet.

## Protokoll

**Anfrage** (POST, JSON):

```json
{
  "chatInput": "Kann ich morgen aufs Matterhorn?",
  "sessionId": "2b5c…",
  "context": { "place": "Zermatt", "route": null, "playing": false, "timeMode": "live", "offsetHours": 0, "weatherSummary": "3 °C, bedeckt" },
  "history": [{ "role": "user", "text": "Hoi" }, { "role": "assistant", "text": "Hoi! …" }]
}
```

**Antwort** (JSON): `{"reply": "…", "actions": [ … ]}`. Erlaubte Aktionen: `flyTo`, `showPlace`, `setRoute`, `play`, `pause`, `setMode` (`car | transit | bike | foot | flight`), `setTime`, `showMountain`, `openWeather`, `compareModes` – Details in `src/chat/protocol.ts`. Die App ist tolerant: Sie akzeptiert auch `{ "output": … }`, Arrays, JSON als Text oder in einem Markdown-Codeblock und verwirft unbekannte Aktionen.

### Test mit curl

```bash
curl -s https://n8n.example.ch/webhook/wetterflug-chat \
  -H 'Content-Type: application/json' \
  -H 'Origin: https://jahwhan.github.io' \
  -d '{"chatInput":"Von Zürich nach Luzern mit dem Zug","sessionId":"test-1","context":{"place":null,"route":null,"playing":false,"timeMode":"live","offsetHours":0,"weatherSummary":null}}'
```

Beispielantwort:

```json
{"reply":"Route von Zürich nach Luzern mit dem ÖV – ich berechne sie.","actions":[{"type":"setRoute","from":"Zürich","to":"Luzern","mode":"transit"}]}
```

## Sicherheit

- **Keine Secrets im Frontend:** Der Anthropic-Schlüssel liegt nur im n8n-Credential. Die Webhook-URL ist öffentlich sichtbar (im Build oder im Browser) – behandle sie nicht als Geheimnis.
- **Kosten begrenzen:** Jede Anfrage kostet Modell-Tokens. Setze in der Anthropic-Konsole ein Ausgabenlimit und begrenze die Rate vor n8n (z. B. Reverse-Proxy mit `limit_req` bei nginx, Cloudflare-Rate-Limiting) oder im Workflow (z. B. Zählung pro `sessionId`/IP).
- **CORS ist kein Schutz gegen Skripte:** Allowed Origins verhindert nur fremde Webseiten im Browser, nicht direkte Aufrufe mit curl. Für mehr Schutz kann ein einfacher geteilter Header geprüft werden – das hält aber nur Gelegenheitsmissbrauch ab.
- **Ausgaben prüfen:** Die App führt nur Aktionen aus der festen Liste aus und validiert alle Felder; freie URLs oder Code aus der Modellantwort werden nie ausgeführt.
- **Datenschutz:** Chat-Texte und der App-Kontext (aktueller Ort, Route) gehen an n8n und Anthropic. Das Chat-Gedächtnis liegt im Arbeitsspeicher von n8n und verfällt beim Neustart.

## Hinweise

- Das SLF-Tool liefert dem Modell nur Regionen, Gefahrenstufen und Gültigkeit (Option *Optimize Response*), weil das volle GeoJSON zu gross ist. Falls deine n8n-Version diese Option nicht kennt, Tool-Antwort in den Node-Einstellungen kürzen oder das Tool entfernen – das Bergwetter-Urteil berechnet die App ohnehin selbst (`showMountain`).
- Bei Claude Haiku 5.5 ist adaptives Denken standardmässig aktiv; im Modell-Node daher keine Temperatur setzen (nicht unterstützte Werte führen zu einem Fehler).
