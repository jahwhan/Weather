# Wetterflug

Wetter-App über einer 3D-Karte, mit Fokus Schweiz. Einen Ort oder eine Route eingeben,
**Abspielen** drücken, und eine Kamerafahrt von 8–16 Sekunden zeigt das Wetter entlang
der Strecke: Licht und Sonnenstand, Tag und Nacht, Wolken, Nebel, Regen, Schnee,
Gewitter und Wind. Daneben (Desktop) bzw. darunter als ziehbares Blatt (Handy) die
Wetterdetails: Stundenleiste, 10 Tage, Kacheln, Messwerte von MeteoSchweiz, Lawinengefahr
vom SLF und die Reisezeiten mit Auto, ÖV, Velo und zu Fuss.

**Live: <https://jahwhan.github.io/Weather/>**

```
npm install
npm run dev        # http://localhost:5173
npm run build      # statische Dateien in dist/, laufen auf jedem Webserver
npm test           # Unit-Tests (node --test)
```

Es braucht keine API-Schlüssel. Alle Dienste sind frei nutzbar und werden direkt aus
dem Browser aufgerufen. Jeder Push auf `main` testet, baut und veröffentlicht die Seite
über GitHub Pages (`.github/workflows/pages.yml`).

## Bedienung

| Eingabe | Ergebnis |
| --- | --- |
| `Bern` | Wetter dort, Abspielen zeigt einen Rundflug |
| `Zürich nach Luzern`, `Zürich - Luzern`, `Zürich → Luzern` | Route von A nach B |
| `von Basel über Olten nach Luzern` | Route mit Zwischenhalt |
| `46.0207, 7.7491 bis Zermatt` | Koordinaten gehen auch |
| Klick auf die Karte | erster Klick setzt den Ort, zweiter Klick das Ziel |

- **Reisezeiten**: Bei einer Route stehen Auto, ÖV, Velo und zu Fuss nebeneinander, jeweils
  mit eigener Dauer. Antippen wählt den Modus für den Flyover. Standard ist das Auto.
- **Zeit**: *Jetzt* (aktuelles Wetter an jedem Punkt) oder *Unterwegs* (Wetter zur
  Ankunftszeit, Start bis +48 h). Bei einem Ort heisst die Option *24 h*: ein Tag im Zeitraffer.
- **Assistent** (Sprechblase oben rechts): Fragen und Befehle auf Deutsch, z. B.
  „Kann ich aufs Matterhorn?“, „Zürich nach Luzern mit dem Zug“, „Wetter in Zermatt“,
  „Spiel ab“, „Morgen um 8“. Der Link `?chat=Kann%20ich%20aufs%20Matterhorn%3F` öffnet den
  Chat mit dieser Frage.
- Profil unten antippen oder ziehen spult die Fahrt. Leertaste spielt ab oder pausiert.
- Beim nächsten Besuch erscheinen der letzte Ort und das letzte Wetter sofort
  („Stand 14:20 · wird aktualisiert“) und werden im Hintergrund erneuert.

## Als App installieren

Wetterflug lässt sich wie eine App auf den Home-Bildschirm legen und startet dann ohne
Browserleisten im Vollbild.

- **iPhone / iPad**: in Safari öffnen → Teilen-Symbol antippen → **Zum Home-Bildschirm**.
- **Android**: in Chrome öffnen → Menü **⋮** → **App installieren** (oder den Knopf
  **Installieren** im Hinweis der App antippen).
- **Desktop** (Chrome, Edge): Installieren-Symbol in der Adressleiste.

Die App zeigt den Hinweis dazu einmal, dezent und erst nach der ersten Bedienung.
Gibt es eine neue Version, erscheint „Neue Version verfügbar“; **Aktualisieren** lädt sie.

## Offline

Ein Service Worker (`src/pwa/`, gebaut nach `dist/sw.js`) speichert die App selbst, die
zuletzt gesehenen Kartenkacheln und die letzten Wetterabfragen. Ohne Netz startet die App
trotzdem, zeigt den letzten Ort mit dem letzten Wetter und den Hinweis
„Offline – Stand 14:20“. Sobald die Verbindung zurück ist, wird aktualisiert.

| Was | Strategie | Grenzen |
| --- | --- | --- |
| Seitenaufruf | zuerst Netz (3 s), sonst gespeicherte App | – |
| App-Dateien (gehasht), Icons, Manifest | aus dem Speicher (vorab geladen) | je Version, alte werden gelöscht |
| Kartenkacheln, Gelände, Luftbild | aus dem Speicher, sonst Netz | 800 Kacheln, 30 Tage |
| TileJSON/Stil-JSON | Speicher sofort, im Hintergrund erneuern | 30 Einträge, 7 Tage |
| Wetter, Messwerte, Suche, ÖV, Routing | zuerst Netz (4 s, wenn etwas gespeichert ist), sonst Speicher | 60 Einträge, 12 Stunden |
| Chat (n8n), alle POST-Abfragen | nie gespeichert | – |

Die Regeln stehen als reine Funktionen in `src/pwa/rules.ts` (Tests: `test/pwa-rules.test.ts`).
Die Icons erzeugt `node scripts/icons.mjs` (Playwright/Chromium) nach `public/icons/`.

## Assistent und n8n

Der Chat versteht ohne Server einfache Wünsche (lokaler deutscher Intent-Parser,
`src/chat/intent.ts`). Mit einem n8n-Workflow beantwortet ein Claude-Modell auch freie
Fragen und steuert die App über ein JSON-Protokoll:

```json
{ "reply": "Ich zeige dir die Fahrt nach Luzern mit dem Zug.",
  "actions": [{ "type": "setRoute", "from": "Zürich", "to": "Luzern", "mode": "transit" }, { "type": "play" }] }
```

Aktionen: `flyTo`, `showPlace`, `setRoute`, `play`, `pause`, `setMode`, `setTime`,
`showMountain`, `openWeather`, `compareModes`. Der importierbare Workflow liegt in
[`n8n/wetterflug-assistent.json`](n8n/wetterflug-assistent.json), die Anleitung in
[`n8n/README.md`](n8n/README.md). Der Workflow läuft produktiv auf n8n Cloud; die
öffentliche Webhook-URL steht als `VITE_N8N_CHAT_URL` in `.env` und wird beim Build
eingebaut. Eine andere URL lässt sich im Chat unter dem Zahnrad eintragen (gespeichert im
Browser). Ist n8n nicht erreichbar, antwortet der lokale Assistent. Im Repository liegen
keine Schlüssel; der Workflow begrenzt die Kosten (10 Nachrichten pro Tag, 10 pro Sitzung).

## Bergwetter

„Kann ich aufs Matterhorn?“ ergibt eine Einschätzung mit Ampel (gut / bedingt / abraten),
Gründen und dem besten Zeitfenster der nächsten 48 h. Grundlage:

- Open-Meteo **am Gipfel** (Parameter `elevation`, in der Schweiz MeteoSchweiz ICON-CH2):
  Temperatur, gefühlte Temperatur, Wind und Böen, Höhenwind aus der passenden Druckfläche,
  Wolken, Sicht, Nullgradgrenze, CAPE und Gewittercodes.
- Niederschlag, Regen und Neuschnee der **letzten 72 Stunden** (nasser oder vereister Fels).
- **Lawinengefahr** aus dem SLF-Bulletin (GeoJSON, Region per Punkt-in-Polygon,
  höhenabhängige Stufe).
- Gipfelliste: die Schweizer 4000er und rund 60 beliebte Gipfel (`src/mountain/peaks.ts`),
  weitere über die geo.admin-Suche.

Jede Antwort endet mit dem Hinweis: Schätzung aus Modelldaten, kein Ersatz für das
SLF-Lawinenbulletin, MeteoSchweiz oder eine Bergführerin / einen Bergführer.

## Datenqualität

Die Daten wurden im November 2026 geprüft und korrigiert. Die vollständigen Befunde mit
Zahlen stehen in [`docs/datenqualitaet.md`](docs/datenqualitaet.md). Kurzfassung:

| Punkt | Befund | Korrektur |
| --- | --- | --- |
| „Zürich bis Luzern = 3 h“ | Standardprofil war Velo (OSRM, 52 km in 3 h 23 ≈ 15 km/h). Für das Velo korrekt, als Standard missverständlich. | Standard Auto; alle Modi nebeneinander und eindeutig beschriftet. Live: Auto 40 min (ohne Verkehr), ÖV 41 min (IR 70, direkt), Velo 3 h 15, zu Fuss 10 h 28. Tempo-Plausibilisierung für Velo und Fuss. |
| ÖV | gab es nicht | transport.opendata.ch: Dauer, Umstiege, Linie aus den Koordinaten der Halte. Orte werden zuerst auf einen Bahnhof aufgelöst (reine Namen landen sonst z. B. bei einer Seilbahnstation). |
| Wettermodell | Open-Meteo `best_match` weltweit | In der Schweiz MeteoSchweiz ICON-CH1 (1 km, ~33 h) → ICON-CH2 (2 km, 5 Tage) → `best_match` → MET Norway; das Modell wird angezeigt. |
| Messwerte | keine | SwissMetNet (MeteoSchweiz, 10-Minuten-Werte, LV95 → WGS84). „Gemessen“ ersetzt den Modellwert für „jetzt“, wenn die Station < 8 km entfernt, < 150 m höher/tiefer und die Messung < 40 min alt ist; sonst steht sie als Vergleich daneben. |
| Höhen / Anstieg | Terrarium-Kacheln, Anstieg roh summiert | In der Schweiz swisstopo-Profildienst (swissALTI3D/DHM25), Anstieg mit 7-m-Hysterese. Rest: Tunnel (Auto) zählen weiter als Hügel, weil OSRM keine Tunnelinfo liefert. |
| Ortssuche | Photon, teils ungenaue Treffer in der Schweiz | geo.admin SearchServer zuerst (Gemeinden, Orte, Gipfel vor Adressen), Photon/Open-Meteo für das Ausland; Rückwärtssuche über geo.admin identify. |
| Karte | Esri-Satellitenbild | In der Schweiz SWISSIMAGE (© swisstopo); ausserhalb Esri/OpenFreeMap. Die swisstopo-Vektorkarte ist bewusst nicht eingebunden (eigener Glyph-Server, doppelte Beschriftungen an der Grenze). |
| Zeitzone | MET-Norway-Rückfall rechnete mit Sonnenzeit (Länge/15) | Zeitzone über `Intl` (Europe/Zurich, inkl. Sommerzeit). |
| Live / Prognose | „Live“ auch bei Modellwerten | „Gemessen“ nur bei Stationswerten, „Live“ für die aktuelle Modellanalyse, „Prognose“ für spätere Zeiten. |
| Schneefallgrenze | – | Wo das Modell sie nicht liefert: Nullgradgrenze − 300 m, als Schätzung markiert. |

Nicht live geprüft werden konnte: grosse Teile der Open-Meteo-Abfragen (das Tageslimit
der geteilten Test-IP war erschöpft; getestet mit Mocks und einzelnen Live-Abfragen),
Photon (nicht erreichbar) und der CORS-Preflight des n8n-Webhooks aus dem Browser (n8n Cloud ist aus der Testumgebung nicht direkt erreichbar; der Workflow selbst lief erfolgreich über die n8n-Schnittstelle).

## Ladezeit

Gemessen mit Playwright/Chromium (Software-Renderer, Netz über einen Proxy, Wetter
gemockt, Median aus 3 Läufen). Absolute Werte sind auf echten Geräten deutlich kleiner;
aussagekräftig ist der Vergleich.

| Messpunkt | vorher | nachher |
| --- | --- | --- |
| Erste Darstellung (FCP) | 0,07 s | 0,04 s |
| Wetter sichtbar, erster Besuch | 18,5 s | 0,35 s |
| Wetter sichtbar, zweiter Besuch | 17,2 s | 0,19 s |
| Karte fertig geladen (`load`), erster Besuch | 9,7 s | 10,1 s |
| Karte fertig geladen (`load`), zweiter Besuch | 8,9 s | 10,9 s |

Das Wetter erscheint nicht mehr erst nach Karte, Route und Intro-Flug, sondern sofort:
beim zweiten Besuch aus dem Zwischenspeicher, beim ersten direkt nach der Wetterabfrage
(im Test gemockt mit 0,12 s Antwortzeit; mit echtem Netz kommt die Antwortzeit von
Open-Meteo dazu). Die Zeit bis zur fertig geladenen Karte hat sich nicht verbessert: Der
Start zeigt jetzt gleich 3D-Gelände mit Schweizer Luftbild statt eines fast leeren
Globus, das sind mehr Kacheln. Die Unterschiede liegen hier innerhalb der Streuung der
Messläufe (8,3–12 s).

Was dazu beigetragen hat: keine Webfonts mehr (System-Schrift), kein Globus-Intro (Start
direkt über der Schweiz), `preconnect` zu den Kartendiensten, letzter Ort, Kamera und
letztes Wetter aus dem Browser-Speicher (stale-while-revalidate), Standardorte ohne
Ortssuche, Chat und Bergwetter per dynamic import, Rauschtexturen im Leerlauf, weniger
Höhenkacheln (Schattierung bis Zoom 12, Gelände bis 14).

## Datenquellen

| Zweck | Dienst |
| --- | --- |
| Wetter | [Open-Meteo](https://open-meteo.com/) mit den MeteoSchweiz-Modellen ICON-CH1/CH2; Rückfall [MET Norway](https://api.met.no/) |
| Messwerte | [MeteoSchweiz](https://www.meteoschweiz.admin.ch/) SwissMetNet über [data.geo.admin.ch](https://data.geo.admin.ch/) |
| Lawinen | [SLF](https://www.slf.ch/) Lawinenbulletin |
| Ortssuche | [geo.admin.ch](https://api3.geo.admin.ch/) (swisstopo); Ausland [Photon](https://photon.komoot.io/), [Open-Meteo Geocoding](https://open-meteo.com/en/docs/geocoding-api) |
| ÖV | [transport.opendata.ch](https://transport.opendata.ch/) |
| Routing | [OSRM](https://project-osrm.org/) auf den FOSSGIS-Servern (routing.openstreetmap.de) |
| Höhen | swisstopo-Profildienst (swissALTI3D); sonst Mapzen Terrain Tiles (AWS Open Data) |
| Karte | SWISSIMAGE © swisstopo; [OpenFreeMap](https://openfreemap.org/) (© OpenStreetMap, OpenMapTiles); Satellitenbild Esri World Imagery |
| Nachtlichter | NASA Black Marble über GIBS |

Dargestellt wird mit [MapLibre GL JS](https://maplibre.org/) 6; Wetter-Effekte, Sonne, Mond
und Sterne zeichnen Canvas-Ebenen über der Karte. Sonnen- und Mondstand nach SunCalc
(BSD-2-Clause). Gestaltung „Liquid Glass“: eigene Formen und Symbole, System-Schrift;
die App steht in keiner Verbindung zu Apple.

## Aufbau

```
src/
  main.ts            Verdrahtung von Karte, Suche, Abspieler, Panel; app-Steuerung für den Chat
  env.ts             Wetter + Sonnenstand → Licht, Farben, Nebel, Niederschlag
  player.ts          Kamerafahrt (Verfolger, Orbit) mit Sichtprüfung im Gebirge
  trip.ts            Ort oder Route samt Wetter-Stützpunkten und Höhenprofil
  astro/sun.ts       Sonne, Mond, Helligkeit in Lux
  weather/           Open-Meteo (MeteoSchweiz-Modelle), MET Norway, Detaildaten für die Wetter-App
  swiss/             LV95, Landesgrenze, geo.admin-Suche, ÖV, swisstopo-Profil, SwissMetNet, SLF
  route/             Ortssuche, Routing, Reisemodi im Vergleich, Höhen, Eingabe zerlegen
  mountain/          Gipfelliste, Gipfelwetter, Regeln für die Einschätzung, Karte im Chat
  chat/              Protokoll, lokaler Intent-Parser, n8n-Client, Chat-Panel
  map/               Kartenstil, Szene (Licht/Himmel/Schatten), Kamera-Geometrie
  fx/                Effekt-Ebenen und Rauschen für Wolken
  ui/                Design-Tokens, Panel/Bottom-Sheet, Wetter-App, Profil, Symbole
  pwa/               Service Worker, Cache-Regeln, Installations-, Update- und Offline-Hinweis
public/              Web-App-Manifest und App-Icons
scripts/             Icon-Generator, Vite-Plugin für den Service Worker
n8n/                 importierbarer Workflow für den Assistenten
docs/                Datenqualität
```

## Hinweise

- Die freien Dienste haben Nutzungsgrenzen. Open-Meteo erlaubt ohne Schlüssel rund
  10 000 Aufrufe pro Tag und Adresse; Ergebnisse werden zwischengespeichert.
- Esri World Imagery ist für nicht-kommerzielle Nutzung mit Quellenangabe frei. Für einen
  kommerziellen Einsatz die Satellitenquelle tauschen (`src/map/style.ts`).
- Wolkenschatten und Regenpartikel stellen die Modellwerte dar (Bedeckung, Wind,
  Niederschlagsmenge); es sind keine Satelliten- oder Radarbilder.
