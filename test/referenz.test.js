// Referenzsatz: echte Logs von SB-10 und Shark mit erwarteten Kennzahlen (test/referenz/erwartet.json).
// Immer dabei: web/beispiel.csv (= SB-10-2026-10-02-14-39-06). Die übrigen Logs liegen nicht im Repo;
// mit MMFA_LOGS=<Ordner mit Unterordnern SB-10, Shark> laufen alle 15 (z. B. das Log-Archiv auf dem Mac).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path');
const H = require('./helpers/ethoslog.js');
const { kennzahlen } = require('./referenz/kennzahlen.js');
const ERW = JSON.parse(fs.readFileSync(path.join(__dirname, 'referenz', 'erwartet.json'), 'utf8'));
const BEISPIEL = path.join(__dirname, '..', 'web', 'beispiel.csv');

function vergleiche(ist, soll, name) {
  for (const [k, v] of Object.entries(soll)) {
    if (k === 'modell') continue;
    if (typeof v === 'number') assert.ok(Math.abs(ist[k] - v) <= 1e-3 * Math.max(1, Math.abs(v)), `${name} ${k}: ${ist[k]} statt ${v}`);
    else assert.deepStrictEqual(ist[k], v, `${name} ${k}`);
  }
}

test('Beispiel-Log (SB-10) liefert die Referenzwerte', () => {
  const ist = kennzahlen(BEISPIEL);
  vergleiche(ist, ERW['SB-10-2026-10-02-14-39-06.csv'], 'beispiel.csv');
  // und ist physikalisch plausibel
  assert.ok(ist.wind_kmh > 5 && ist.wind_kmh < 40, 'Wind'); assert.ok(ist.tas_kmh > 30 && ist.tas_kmh < 80, 'TAS');
  assert.deepStrictEqual(ist.klappenpaare, ['K1/K5:diff', 'K6/K7:diff', 'K8/K9:diff']);
});

const DIR = process.env.MMFA_LOGS;
const finde = f => { for (const m of fs.readdirSync(DIR)) { const p = path.join(DIR, m, f); if (fs.existsSync(p)) return p; } return null; };

test('Alle Referenzlogs liefern die Referenzwerte', { skip: !DIR && 'MMFA_LOGS nicht gesetzt' }, () => {
  let n = 0;
  for (const [f, soll] of Object.entries(ERW)) { const p = finde(f); if (!p) continue; vergleiche(kennzahlen(p), soll, f); n++; }
  assert.ok(n >= 2, `nur ${n} Logs gefunden`);
});

// Je Modell: Polare aus allen Logs, nach Klappenstellung getrennt. Die Normalstellung (häufigste) muss eine plausible,
// in sich stimmige Polare geben; die Mischung aller Stellungen weicht davon ab (darum der Klappenfilter).
test('Klappenfilter: Normalstellung je Modell gibt eine stimmige Polare', { skip: !DIR && 'MMFA_LOGS nicht gesetzt' }, () => {
  for (const m of ['SB-10', 'Shark']) {
    const md = path.join(DIR, m); if (!fs.existsSync(md)) continue;
    const logs = Object.keys(ERW).filter(f => ERW[f].modell === m).map(f => path.join(md, f)).filter(fs.existsSync).map(H.lesen);
    const per = logs.map(log => { const a = H.auswerten(log), s = H.servos(log), p = H.KL.vorschlag(s.kanaele, s.qr), W = H.KL.woelbung(log.t, s.kanaele, p);
      return { a, v: a.pts.map(q => H.KL.vektor(W, q[2])) }; });
    const st = H.KL.stellungen(per.flatMap(p => p.v));
    assert.strictEqual(st.length, 2, `${m}: zwei Klappenstellungen`);
    const norm = st.reduce((a, b) => b.anteil > a.anteil ? b : a), ni = st.indexOf(norm);
    const pts = per.flatMap(p => p.a.pts.filter((_, i) => H.KL.stellungVon(p.v[i], st) === ni));
    const f = H.PO.polarFit(H.PO.polarBins(pts));
    assert.ok(f.ld > 20 && f.ld < 35, `${m}: Gleitzahl ${f.ld}`);
    assert.ok(f.wms > 0.35 && f.wms < 0.7, `${m}: geringstes Sinken ${f.wms}`);
  }
});
