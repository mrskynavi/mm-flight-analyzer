# Rechenkern (web/core/)

Die Rechnungen des Flight Analyzers ohne Oberfläche. Jede Datei läuft im Browser (`window.MMFA.<modul>`) und in Node (`require`). Sie sollen später auch im Plane Analyzer und als Vorlage für die Lua-Widgets dienen.

| Datei | Inhalt |
| --- | --- |
| `wind.js` | GPS-Kurs (halbe Fixe), Kasa-Kreisfit, Wind Estimator (Nachbau des Widgets, Median der letzten 5 Fits, Kursstreuung 0,3), TAS, Steuerkurs, Drift, Gegenwind |
| `polare.js` | Gleitpunkte (1 je Sekunde, Motor aus + 15 s, geradeaus, Energiekompensation, optional Dichte und nur ab erstem Windfit), Klassen, Ausreisser-Klassen (polarClean), Fit A·v³ + B/v, Abriss-Fit A·v³ + B/v + D/v³ (polarFit3, nur mit langsamen Klassen gültig), Median-Kurve, Eigensinken in der Höhe, Parabel a·v² + b·v + c |
| `energie.js` | Glättung über Zeit, Vario TEK, Netto-Vario (10 s und 3 s), Gleitzahl |
| `atmosphaere.js` | Normatmosphäre (σ = ρ/ρ0, mit Temperaturabweichung), σ je Logzeile aus Platzhöhe + Höhe, Fluggelände suchen |
| `klappen.js` | Klappenpaare erkennen, Wölbung je Paar in % Servoweg, Klappenstellungen finden (Mean-Shift), Zuordnung |

## Tests

- `npm test` läuft `test/kern.test.js` (konstruierte Flüge mit bekanntem Ergebnis) und `test/referenz.test.js` (mit `web/beispiel.csv`).
- Alle 15 Referenzlogs von SB-10 und Shark: `MMFA_LOGS=<Log-Ordner mit Unterordnern SB-10 und Shark> npm test`. Die erwarteten Kennzahlen stehen in `test/referenz/erwartet.json`; nach einer gewollten Änderung der Rechnung mit `node test/referenz/erzeugen.js <Log-Ordner>` neu schreiben und die Unterschiede begründen.
- `node scripts/vergleich-alt-neu.js --alt <git-ref> <log.csv> …` rechnet dieselben Logs mit einem älteren Stand von `web/index.html` und mit dem aktuellen im Browser (Playwright) und vergleicht alle berechneten Spalten und die Polare.
