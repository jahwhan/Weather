# Wetterflug

Interaktive 3D-Wetterkarte. Einen Ort oder eine Route eingeben (oder auf die Karte
klicken), **Abspielen** drücken, und eine Kamerafahrt von 8–16 Sekunden zeigt das
**Live-Wetter** entlang der Strecke: Licht und Helligkeit, Sonnenstand und Schatten,
Tag und Nacht, Wolken, Nebel und Sichtweite, Regen, Schnee, Gewitter und Wind.

**Live: <https://jahwhan.github.io/Weather/>**

```
npm install
npm run dev        # http://localhost:5173
npm run build      # statische Dateien in dist/, laufen auf jedem Webserver
npm test           # Sonnenstand und Routen-Eingabe
```

Es braucht keine API-Schlüssel. Alle Dienste sind frei nutzbar und werden direkt aus
dem Browser aufgerufen. Jeder Push auf `main` testet, baut und veröffentlicht die Seite
über GitHub Pages (`.github/workflows/pages.yml`).

## Bedienung

| Eingabe | Ergebnis |
| --- | --- |
| `Bern` | Rundflug um den Ort, Wetter dort |
| `Zürich bis Luzern`, `Zürich - Luzern`, `Zürich → Luzern` | Route von A nach B |
| `von Basel über Olten nach Luzern` | Route mit Zwischenhalt |
| `46.0207, 7.7491 bis Zermatt` | Koordinaten gehen auch |
| Klick auf die Karte | erster Klick setzt den Ort, zweiter Klick das Ziel |

- **Velo / Zu Fuss / Auto / Flug**: Strassenrouting über OSRM, Flug als Grosskreis.
- **Jetzt**: an jedem Punkt das aktuelle Wetter.
- **Unterwegs**: Wetter und Sonnenstand zu der Zeit, zu der man den Punkt erreicht
  (Startzeit wählbar, bis +48 h). Bei einem einzelnen Ort heisst die Option **24 h**:
  Zeitraffer über einen ganzen Tag mit Sonnenlauf und Wetterwechsel.
- **Dauer**: Auto (8 s für kurze, 16 s für sehr lange Strecken) oder fest.
- Profil unten anklicken oder ziehen spult die Fahrt. Leertaste spielt ab oder pausiert.

## Was die Darstellung aus den Daten macht

| Daten | Darstellung |
| --- | --- |
| Sonnenstand (berechnet für Ort und Zeit) | Lichtrichtung auf Gelände und 3D-Gebäuden, Sonnenscheibe, Himmelsfarbe, Morgen- und Abendrot |
| Globalstrahlung, direkte/diffuse Strahlung | Helligkeit in Lux, Härte der Schatten |
| Bewölkung tief/mittel/hoch | Wolkenhimmel, Grauschleier, Wolkenschatten, die mit dem Wind über das Gelände ziehen |
| Sichtweite, Nebelanteil | Nebel über dem Gelände und in der Luft, Dunst am Horizont |
| Niederschlag, Wettercode, Temperatur | Regen, Niesel, Schnee, Schneeregen, Hagel, Blitze; Schnee hellt den Boden auf |
| Windrichtung und -stärke | Schräge des Regens, Drift von Schnee und Wolken |
| Mondstand und -phase | Mond mit Phase, Mondlicht nachts |
| Nacht | Stadtlichter (NASA Black Marble), Strassenbeleuchtung, Sterne bei klarem Himmel, Lichtglocke unter Wolken |

Das Wetterinstrument oben rechts zeigt die Werte an der aktuellen Position der Fahrt,
darunter das Profil mit Höhe, Temperatur, Niederschlag, Bewölkung und Tag/Nacht.

## Datenquellen

| Zweck | Dienst |
| --- | --- |
| Wetter | [Open-Meteo](https://open-meteo.com/) (aktuelle Werte und Stundenprognose); fällt Open-Meteo aus, [MET Norway](https://api.met.no/) |
| Ortssuche | [Photon](https://photon.komoot.io/) (komoot), Rückfall [Open-Meteo Geocoding](https://open-meteo.com/en/docs/geocoding-api) |
| Routing | [OSRM](https://project-osrm.org/) auf den FOSSGIS-Servern (routing.openstreetmap.de) |
| Karte | [OpenFreeMap](https://openfreemap.org/) (OpenStreetMap, OpenMapTiles), Satellitenbild Esri World Imagery |
| Gelände | Mapzen Terrain Tiles (AWS Open Data) |
| Nachtlichter | NASA Black Marble über GIBS |

Dargestellt wird mit [MapLibre GL JS](https://maplibre.org/) 6 (Globus, 3D-Gelände,
Himmel und Nebel); Wetter-Effekte, Sonne, Mond und Sterne zeichnen drei Canvas-Ebenen
über der Karte. Sonnen- und Mondstand nach SunCalc (BSD-2-Clause).

## Aufbau

```
src/
  main.ts            Verdrahtung von Karte, Eingabe, Abspieler und Anzeigen
  env.ts             Wetter + Sonnenstand → Licht, Farben, Nebel, Niederschlag
  player.ts          Kamerafahrt (Verfolger, Orbit), deterministisch für das Spulen
  trip.ts            Ort oder Route samt Wetter-Stützpunkten und Höhenprofil
  astro/sun.ts       Sonne, Mond, Helligkeit in Lux
  weather/           Open-Meteo, MET Norway, WMO-Codes
  route/             Ortssuche, Routing, Höhen, Eingabe zerlegen
  map/               Kartenstil, Szene (Licht/Himmel/Schatten), Kamera-Geometrie
  fx/                Effekt-Ebenen und Rauschen für Wolken
  ui/                Wetterinstrument, Profil, Symbole
```

## Hinweise

- Die freien Dienste haben Nutzungsgrenzen. Open-Meteo erlaubt ohne Schlüssel rund
  10 000 Aufrufe pro Tag und Adresse; Ergebnisse werden 10 Minuten zwischengespeichert,
  Suchergebnisse im Browser.
- Esri World Imagery ist für nicht-kommerzielle Nutzung mit Quellenangabe frei. Für einen
  kommerziellen Einsatz die Satellitenquelle tauschen (`src/map/style.ts`).
- Die Wolkenschatten und Regenpartikel sind eine Darstellung der gemessenen Werte
  (Bedeckungsgrad, Wind, Niederschlagsmenge), keine Satellitenaufnahme der Wolken.
