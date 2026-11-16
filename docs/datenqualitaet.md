# Datenqualität und Schweizer Datenquellen

Befunde aus der Prüfung im November 2026 (Live-Abfragen am 16.11.2026 gegen 12 Uhr MEZ).
Für jeden Punkt: Befund, Korrektur, was nicht live getestet werden konnte.

## Übersicht der Quellen

| Bereich | In der Schweiz | Ausserhalb / Rückfall |
|---|---|---|
| Ortssuche | geo.admin SearchServer (swisstopo) | Photon (komoot) → Open-Meteo-Geocoding |
| Rückwärtssuche | geo.admin identify (Gemeinde, Ortschaft/PLZ, swissNAMES3D-Gipfel) | Photon reverse |
| ÖV | transport.opendata.ch | – (Strassenroute mit Hinweis) |
| Auto/Velo/Fuss | OSRM (FOSSGIS, routing.openstreetmap.de) | dito, Auto zusätzlich router.project-osrm.org |
| Höhenprofil | swisstopo-Profildienst (swissALTI3D/DHM25) | Terrarium-Kacheln (AWS/Mapzen) |
| Wettermodell | Open-Meteo mit MeteoSchweiz ICON-CH1 → ICON-CH2 → best_match | Open-Meteo best_match → MET Norway |
| Messwerte | SwissMetNet (MeteoSchweiz, data.geo.admin.ch) | – |
| Luftbild | SWISSIMAGE (wmts.geo.admin.ch) ab Zoom 8 | Esri World Imagery |

Alle Schweizer Dienste antworten mit `Access-Control-Allow-Origin: *` und funktionieren direkt aus dem Browser.

## Reisemodi (Beschwerde „Zürich bis Luzern = 3 h“)

**Befund:** Standardprofil war Velo. OSRM-Velo rechnet Zürich HB → Luzern Bahnhof mit 51,8 km in 203 min
(15,3 km/h) – korrekt fürs Velo, aber als Standard irreführend.

**Korrektur:** Standard ist jetzt `car` (`DEFAULT_PROFILE`), neu gibt es `transit` (ÖV). `compareModes()`
lädt Auto, ÖV, Velo und Fuss parallel; die Ergebnisse landen im Routen-Zwischenspeicher, ein
anschliessendes `computeRoute` für denselben Modus lädt nichts nach.

Live-Werte Zürich → Luzern (Gemeinde-Mittelpunkte aus der geo.admin-Suche, `compareModes`, 16.11.2026):

| Modus | Dauer | Distanz | Detail |
|---|---|---|---|
| Auto | 40 min | 51,0 km | OSRM, ohne Verkehr |
| ÖV | 41 min | 43,5 km* | IR 70 · direkt |
| Velo | 3 h 15 min | 51,4 km | Ø 15,8 km/h |
| Zu Fuss | 10 h 28 min | 47,4 km | Ø 4,5 km/h |

\* Die ÖV-Distanz ist die Länge der Linie zwischen den Halten (IR 70: Zürich HB – Zug – Luzern), also
Luftlinie zwischen den Halten und kürzer als die Gleise. Bahnhof zu Bahnhof (Zürich HB → Luzern) ergibt
OSRM für das Auto 52,5 km / 42 min, für das Velo 51,8 km / 203 min, zu Fuss 47,9 km / 635 min.

- **Auto:** Die FOSSGIS-Instanz rechnet ohne Verkehr (Freifluss). 40–42 min sind für Zürich–Luzern
  eher knapp; zur Hauptverkehrszeit sind 50–60 min realistisch. Im Vergleich steht daher „ohne Verkehr“.
- **Velo/Fuss:** Gemessene Tempi 15,3–15,8 km/h (Velo) und 4,5 km/h (Fuss) sind plausibel. Zur Sicherheit
  prüft `plausibleDuration()` das Tempo (Velo 10–25 km/h, Fuss 3–6 km/h) und schätzt sonst mit 16 bzw.
  4,7 km/h neu. Steigungen berücksichtigt OSRM nur grob; bei Bergstrecken ist die Velo-Zeit optimistisch.
- **Zu weit:** Im Vergleich gilt Fuss ab 80 km, Velo ab 300 km Luftlinie als „nicht verfügbar“; ÖV nur,
  wenn alle Orte in der Schweiz oder grenznah (~25 km) liegen und mindestens einer in der Schweiz.
  `computeRoute` behält die bisherigen Grenzen (Fluglinie mit Hinweis).

### ÖV (transport.opendata.ch)

- `from`/`to` akzeptieren Namen, Stations-IDs und Koordinaten als „Breite,Länge“. Bei Koordinaten ergänzt
  der Dienst Fusswege (z. B. 53 statt 41 min ab einer Adresse). Für Orte wird deshalb zuerst ein
  Bahnhof gesucht: Namenssuche `locations?query=…&type=station`, Bahnhof (`icon: train`) bis 5 km vom
  Ort; sonst nächste Haltestelle über `locations?x=…&y=…` (Bahn bis 1,5 km, sonst jede bis 1 km);
  sonst die Koordinate. Grund: reine Namen werden falsch aufgelöst („Davos“ → „Davos Glaris
  (Talst.Jatzmeder)“, „Rigi“ → „Zürich, Seilbahn Rigiblick“).
- **Achtung:** In den Antworten ist `coordinate.x` die **Breite** und `y` die **Länge**.
- Dauerformat `"00d00:41:00"`; aus vier Verbindungen wird die schnellste genommen (bei Gleichstand die
  mit weniger Umstiegen). Detailtext aus `products` und `transfers`: „IR 70 · direkt“, „IC 8 · R · 1 Umstieg“.
- Die Flyover-Linie verbindet die Halte der `passList` gerade (Fernverkehr hält selten, die Linie ist dann
  grob). Fusswege werden als gerade Stücke angehängt. Mehrere Orte: Etappen aneinandergehängt, Wartezeiten
  zwischen den Etappen nicht mitgezählt.
- Ohne Fahrplan (Ausland) zeigt `computeRoute(…, 'transit')` die Strassenroute (Profil `car`) mit Hinweis.

## Ortssuche

**Befund:** Photon liefert für Schweizer Orte oft Strassen oder Ortsteile; ausserdem ist der Dienst aus
manchen Netzen nicht erreichbar.

**Korrektur:** geo.admin SearchServer zuerst (`type=locations`, `sr=4326`, `lang=de`). Labels mit HTML
(`<b>`, `<i>`) werden bereinigt, Rangfolge: Gemeinde (gg25) → PLZ → Ort (Siedlungsname) → Gipfel →
Kanton/Bezirk → Gelände/Haltestellen → Adressen → Flurnamen → Parzellen. Exakte Namen und Wortanfänge
(„Rigi“ → „Rigi Kulm“, nicht „Rigiblick“) werden bevorzugt, Dubletten (Gemeinde + gleichnamige Siedlung,
doppelte Gazetteer-Einträge mit Zeilenumbruch) entfernt. Detailtexte: „Gemeinde, LU“, „Kanton“,
„Alpiner Gipfel, 4477 m“ (Höhe aus dem swisstopo-Höhendienst für bis zu drei Gipfel), „8001 Zürich“.

Passt kein Treffer eindeutig (z. B. „Paris“ → nur „Les Paris“ (Flurname), „Parisbüchel“), kommen die
Auslandstreffer (Photon/Open-Meteo) zuerst. Beide Quellen laufen parallel; ist die Schweiz eindeutig,
wird die Auslandsabfrage abgebrochen. Cache-Schlüssel neu `wetterflug.geocode.v2` (v1 wird gelöscht),
Vorbelegung über localStorage bleibt möglich.

Eigenheiten des SearchServers: Mehrsprachige Gipfelnamen kommen als „Matterhorn Mont Cervin|Monte Cervino“
(es wird der zur Eingabe passende Teil gezeigt); Objektarten teils ohne Umlaute („Uebrige Bahnen“, wird
umgeschrieben); bei `sr=2056` sind `x`/`y` vertauscht (y = Ost), deshalb wird `sr=4326` mit `lat`/`lon` benutzt.

**Rückwärtssuche:** `identify` auf `ch.swisstopo.swissboundaries3d-gemeinde-flaeche.fill` liefert ohne
Zeitangabe alle historischen Stände (177 Treffer für Luzern ab 1894!). Mit `timeInstant=<Vorjahr>`
kommt genau ein Treffer. Zusätzlich das Ortschaftenverzeichnis (PLZ/Ortschaft, z. B. „Davos Platz“,
Gemeinde Davos) und swissNAMES3D im Umkreis von ~200 m für Gipfel/Pässe (amtlicher Name bevorzugt:
„Matterhorn“ statt „Monte Cervino“), Höhe aus dem Höhendienst. `layerDefs`-Filter funktioniert für
swissNAMES3D nicht (keine abfragbaren Attribute), Geometrien werden deshalb nicht mitgeladen (sonst bis
340 KB in Städten), sondern nur für den gefundenen Gipfel einzeln.

## Höhenprofil und Anstieg

**Befund:** Bisher Terrarium-Kacheln (in der Schweiz ~25–30 m Raster), 3-Punkt-Glättung, dann jede
Differenz aufsummiert.

**Korrektur:** Liegt die Strecke vollständig in der Schweiz, kommen die Höhen vom swisstopo-Profildienst
(`POST profile.json?sr=2056&distinct_points=true`, Koordinaten in LV95). Der Dienst nimmt höchstens 5000
Stützpunkte (HTTP 413 darüber, live geprüft), wir senden die 40–240 Profilpunkte, bei sehr langen Linien
höchstens 3000. Die Antwort wird über die Distanz entlang der Linie auf die eigenen Punkte abgebildet
(der Dienst fügt Zwischenpunkte ein). Rückfall Terrarium. `Trip.elevationSource` sagt, woher die Höhen kommen.

Anstieg/Abstieg neu mit Hysterese 7 m (`climbStats`): Eine Änderung zählt erst, wenn sie seit dem
letzten gezählten Punkt mindestens 7 m beträgt. swisstopo-Höhen werden ungeglättet ausgewertet,
Terrarium-Höhen nach der 3-Punkt-Glättung. Die Profilkurve bleibt leicht geglättet.

Zürich HB → Luzern Bahnhof (OSRM-Routen, Stützpunkte alle ~250 m):

| Modus | vorher (Terrarium, geglättet, roh summiert) | Terrarium roh | swisstopo roh | **neu (swisstopo, Hysterese 7 m)** |
|---|---|---|---|---|
| Auto (52,5 km) | ↑ 669 / ↓ 639 m | ↑ 875 m | ↑ 794 m | **↑ 702 / ↓ 676 m** |
| Velo (51,8 km) | ↑ 549 / ↓ 524 m | ↑ 722 m | ↑ 657 m | **↑ 570 / ↓ 542 m** |
| Fuss (47,9 km) | ↑ 543 / ↓ 520 m | ↑ 678 m | ↑ 636 m | **↑ 535 / ↓ 507 m** |

Vergleich der Schwellen (swisstopo): Velo 5 m → 574, 7 m → 570, 10 m → 539 m; mit zusätzlicher Glättung
483 m. Die Velo-Route führt über den Albispass (791 m; Profil-Maximum 789 m), ↑ ~570 m ist plausibel.
Die Zahlen sind ähnlich wie vorher, weil die alte Glättung das Rauschen schon teilweise unterdrückte –
dafür ist das Profil jetzt genauer (Start 408 m, Ziel 436 m, Minimum/Maximum stimmen mit der Karte).

**Offen – Tunnel:** Für das Auto ist der Anstieg zu hoch, weil das Geländemodell über Tunnel
(Uetliberg-, Islisbergtunnel) die Hügeloberfläche liefert (Profil-Maximum 797 m, die Autobahn liegt viel
tiefer). OSRM (FOSSGIS-Auto) liefert keine Tunnel-Klassen (`intersections[].classes` leer; beim Velo-Profil
gibt es sie). Eine Steigungsbegrenzung (max. 8–15 %) senkt den Wert nur auf 480–600 m und würde echte
Passstrassen verfälschen, deshalb nicht umgesetzt.

## Wetter

### MeteoSchweiz-Modelle über Open-Meteo

- Modellnamen live geprüft: `meteoswiss_icon_ch1` (HTTP 200) und `meteoswiss_icon_ch2` (200); ein
  ungültiger Name ergibt HTTP 400 mit `reason`. `meteoswiss_icon_seamless` konnte wegen Zeitüberschreitung
  bzw. Tageslimit nicht geprüft werden und wird nicht benutzt.
- Reichweite live (Zürich): ICON-CH1 ~33 h, ICON-CH2 120 h (Tage 6–10 `null`). `uv_index` ist bei beiden
  Modellen durchgehend `null`. `snowfall_height` und `freezing_level_height` liefern beide.
- Deshalb wird in der Schweiz `models=meteoswiss_icon_ch1,meteoswiss_icon_ch2,best_match` angefragt und
  pro Wert der erste vorhandene genommen (CH1 → CH2 → best_match). So gibt es 10 Tage und UV, und Orte
  ausserhalb des CH-Gebiets bekommen best_match.
- Kette: CH-Modelle → bei HTTP 400 oder fehlenden aktuellen Werten ohne `models` (best_match) → bei 429,
  Netzfehlern o. Ä. MET Norway. `PointWeather.model`/`WeatherDetail.model` nennt das Modell des aktuellen
  Zustands, z. B. „MeteoSchweiz ICON-CH1“.
- **Nicht vollständig live getestet:** api.open-meteo.com antwortete meist mit 429 (Tageslimit des
  Container-Netzes). Einzelne Einzelmodell-Abfragen und eine vollständige `fetchDetail`-Abfrage mit drei
  Modellen gingen durch (10 Tage, Schneefallgrenze vom Modell, Sonnenaufgang 06:31:39 UTC), das
  Antwortformat der Mehrmodell-Abfrage (Zusatz `_<modell>` an den Variablen, bei `current` evtl. ohne
  Zusatz) konnte aber nicht im Detail angesehen werden. Der Parser nimmt deshalb beide Formen
  (mit/ohne Zusatz) und bestimmt das Modell-Label notfalls aus der Stundenreihe. Bei dieser einen Live-
  Abfrage blieb das Modell-Label leer – Hinweis, dass `current` ohne Zusatz kam; das ist inzwischen abgefangen.

### Zeitzone

- Open-Meteo: `timezone=auto` (liefert für die Schweiz „Europe/Zurich“, live geprüft, Offset 3600 s).
- MET Norway liefert keine Zeitzone. In der Schweiz jetzt `Europe/Zurich` über `Intl` (inkl. Sommerzeit),
  ausserhalb weiterhin Sonnenzeit-Näherung (Länge/15°), weil ohne Zeitzonen-Datenbank kein IANA-Name
  bekannt ist.

### Einheiten

| Grösse | Open-Meteo | MET Norway | SwissMetNet | Befund |
|---|---|---|---|---|
| Wind | km/h (`wind_speed_unit=kmh`) | m/s → ×3,6 | km/h | korrekt |
| Druck | `pressure_msl` hPa (Modell-MSL) | `air_pressure_at_sea_level` hPa | QFF hPa (`pp0qffs0`) | MSL und QFF sind beide auf Meereshöhe reduziert, aber mit unterschiedlicher Methode; Abweichung meist < 1–2 hPa, im Gebirge mehr. Bergstationen haben kein QFF („-“), dann bleibt der Modellwert. QNH wird nicht benutzt. |
| Niederschlag | mm/h, Tagessumme mm | mm je 1 h/6 h | mm je 10 min | Messwert ×6 als mm/h nur bei Regen |
| Schnee | `snowfall` cm/h, `snowfall_sum` cm | – | – | korrekt als cm; MET hat keinen Schneefall (`null`) |
| Sichtweite | m | – | – | |
| UV | Index | nur `ultraviolet_index_clear_sky` | – | MET-Wert wird mit Bewölkung abgeschwächt (Faktor 1 − 0,75·N^3,4), Schätzung |

### Detailansicht (`fetchDetail`)

- Open-Meteo: 10 Tage, Stunden ab der aktuellen Stunde (48 h), zusätzliche Stundenwerte
  Regenwahrscheinlichkeit, UV, Tag/Nacht, Nullgradgrenze, Schneefallgrenze.
- Schneefallgrenze: `snowfall_height` (ICON-Modelle) wenn vorhanden, sonst Nullgradgrenze − 300 m mit
  `snowLineEstimated: true`. Live Zürich: Nullgradgrenze 1820 m, Schneefallgrenze 1470 m (Modell).
- MET-Rückfall: Tage aus 1-h- und 6-h-Blöcken (Niederschlag ohne Doppelzählung), Höchst-/Tiefstwerte
  inkl. `air_temperature_max/min` der 6-h-Blöcke, vorherrschende Windrichtung als Vektormittel,
  Tagessymbol: Niederschlag, wenn er ≥ ¼ des Tages betrifft, sonst häufigstes Symbol (06–18 Uhr).
  Liefert 9–10 Tage (Zürich: Reihe endet nach ~9,1 Tagen). Nullgradgrenze aus der Temperatur über die
  Standardatmosphäre (0,65 K/100 m) geschätzt (`freezingLevelEstimated`), Regenwahrscheinlichkeit gibt
  MET für die Schweiz nicht (`null`). Der erste Tag umfasst nur die restlichen Stunden.
- Zwischenspeicher 10 min im Speicher und im localStorage (`wetterflug.detail.v1`, höchstens 6 Orte,
  Schlüssel auf 0,01° gerundet). `cachedDetail()` gibt auch ältere Daten zurück (`fetchedAt` für „Stand HH:MM“).

### Sonnenzeiten und Helligkeit

- `src/astro/sun.ts` vs. Open-Meteo, Zürich 16.11.2026: Aufgang 06:32:41 UTC vs. 06:31:33 UTC
  (Abweichung ~1 min, liegt an Refraktions-/Höhenannahmen). Unkritisch.
- Helligkeit: `illuminanceLux` rechnet Globalstrahlung × 120 lm/W. Bei klarem Himmel ergibt das
  16 500 lx (Sonne 10° hoch), 59 000 lx (30°), 107 000 lx (60°) – plausibel (Literatur: 100–120 klx bei
  hohem Sonnenstand; Lichtausbeute der Globalstrahlung ~105–125 lm/W). Keine Korrektur.

## SwissMetNet-Messwerte

**Befund:** Die Einzel-GeoJSONs (`ch.meteoschweiz.messwerte-<grösse>-10min`) sind je ~150–170 KB gross
(HTML-Beschreibung pro Station, kein gzip). Für sieben Grössen wären das ~1 MB alle 10 Minuten.

**Korrektur:** Hauptquelle ist die Sammeldatei `ch.meteoschweiz.messwerte-aktuell/VQHA80.csv`
(16 KB, alle Stationen, alle Grössen, Zeit in UTC, fehlende Werte „-“) plus das Stationsverzeichnis
`ch.meteoschweiz.messnetz-automatisch_de.csv` (105 KB, **Latin-1**, mit WGS84- und LV95-Koordinaten,
eine Woche im localStorage). Fällt VQHA80 aus, werden die GeoJSONs geladen (Temperatur Pflicht, Rest
parallel und fehlertolerant; Koordinaten LV95 → `lv95ToWgs84`).

Live geprüfte GeoJSON-Datensätze: lufttemperatur-10min (152 Stationen), niederschlag-10min (280),
windgeschwindigkeit-kmh-10min (155, mit `wind_direction`), wind-boeenspitze-kmh-10min (155),
luftfeuchtigkeit-10min (152), luftdruck-qff-10min (60), luftdruck-qfe/qnh-10min, sonnenscheindauer-10min
(131), globalstrahlung-10min, taupunkt-10min, foehn-10min, gesamtschnee-1d/neuschnee-1d (manuell, viele
Werte 99999 = fehlend). Nicht vorhanden: windgeschwindigkeit-10min, windrichtung-10min, schneehoehe.

- `reference_ts` ist UTC (z. B. 11:00Z = 12:00 MEZ); die Daten waren beim Test 5–15 min alt.
- `altitude` ist im GeoJSON die Sensorhöhe (Luzern 456,32 m), im Stationsverzeichnis die Stationshöhe (454 m).
- Übernahme in den „jetzt“-Zustand (`shouldUseObservation`): Station < 8 km, Höhenunterschied < 150 m,
  Messung < 40 min alt. Beispiel: Zürich HB (408 m) bekommt **keine** Messung von Zürich/Fluntern
  (604 m, 196 m höher), Luzern Bahnhof dagegen von Luzern (1,7 km, 454 m).
- Bei der Wahl der nächsten Station zählt ein Höhenunterschied wie zusätzliche Distanz (100 m ≈ 2 km),
  damit z. B. auf dem Pilatus die Gipfelstation statt Luzern gewählt wird.

## Karte

- SWISSIMAGE (`ch.swisstopo.swissimage`, 3857-Kacheln bis z20 vorhanden) liegt ab Zoom 8 über dem
  Esri-Bild (weich eingeblendet bis 9,5), begrenzt auf `bounds` [5.95, 45.81, 10.5, 47.81]. Ausserhalb der
  Schweiz antwortet der Dienst mit HTTP 400; innerhalb der Rechteck-Grenze, aber ausserhalb der
  Abdeckung, kann es daher einzelne 400-Antworten in der Konsole geben (Esri bleibt sichtbar). Helligkeit,
  Sättigung und Kontrast folgen dem Satellitenbild (scene.ts). Attribution „Luftbild © swisstopo“.
- swisstopo-Vektorkarte (`ch.swisstopo.base.vt`, OpenMapTiles-ähnliches Schema mit place,
  mountain_peak, transportation …) geprüft, aber **nicht** eingebunden: Die Beschriftung müsste in der
  Schweiz die OpenFreeMap-Ebenen ersetzen (räumlicher Filter `within` an der Grenze, doppelte Labels,
  eigene Schriften „Frutiger Neue“ von einem anderen Glyph-Server – ein Stil kann nur einen Glyph-Server
  haben), und scene.ts passt die Strassen-/Ortsebenen per ID an. Aufwand und Risiko zu gross;
  OpenFreeMap-Beschriftung bleibt.
- Höhenkacheln: Terrarium bleibt. wmts.geo.admin.ch bietet nur schattierte Reliefs
  (`ch.swisstopo.swissalti3d-reliefschattierung`, PNG), kein Terrain-RGB; das 3D-Gelände von swisstopo
  gibt es nur als Cesium-Quantized-Mesh.
- Weniger Kacheln: `dem-shade` (Schattierung) maxzoom 14 → 12, `dem-terrain` 15 → 14. Terrarium hat in
  Europa ~25–30 m Auflösung, höhere Stufen bringen kaum Detail, aber je Stufe viermal so viele Anfragen.

## LV95 und Landesgrenze

- `wgs84ToLv95`/`lv95ToWgs84`: swisstopo-Näherungsformeln, getestet am Projektionszentrum (Sternwarte Bern
  ↔ E 2 600 000 / N 1 200 000) und am Beispiel aus der swisstopo-Dokumentation (< 1 m). Hin und zurück
  bis ~2 m (Genf), weil beide Richtungen je ~1 m Fehler haben.
- `isInSwitzerland`: Landesgrenze aus swissBOUNDARIES3D (über identify geladen), mit Douglas-Peucker auf
  ~1 km vereinfacht (310 + 12 Punkte, inkl. Liechtenstein). Enklaven (Büsingen, Campione) zählen als
  Schweiz. Grenzorte innerhalb ~1 km können falsch eingeordnet werden.

## Nicht live getestet

- Mehrmodell-Antworten von Open-Meteo im Detail (Tageslimit 429), siehe oben.
- Photon (photon.komoot.io antwortet aus diesem Container nicht) – nur über Mocks.
- Verhalten im Browser (CORS-Kopfzeilen per curl geprüft, die App selbst nicht gestartet).
