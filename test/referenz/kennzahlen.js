// Kennzahlen eines Logs für den Referenzsatz (test/referenz.test.js); erzeugen.js schreibt sie nach erwartet.json
const H = require('../helpers/ethoslog.js');
const r4 = x => x == null || !isFinite(x) ? null : Math.round(x * 1e4) / 1e4;

function kennzahlen(file) {
  const log = H.lesen(file), a = H.auswerten(log), f = H.PO.polarFit(H.PO.polarBins(a.pts));
  const d = H.auswerten(log, { platz: 410 }), fd = H.PO.polarFit(H.PO.polarBins(d.pts));
  const ab = f ? { A: f.A, B: f.B } : null, tn = ab ? H.auswerten(log, { ab }).tn : a.tn;
  const s = H.servos(log), paare = s.qr ? H.KL.vorschlag(s.kanaele, s.qr) : [];
  const med = arr => { const v = arr ? arr.filter(x => !isNaN(x)) : []; return v.length ? H.PO.median(v) : null; };
  return {
    zeilen: log.t.length, gleitpunkte: a.pts.length, windfits: a.wind ? a.wind.fits : 0,
    wind_kmh: r4(a.wind && a.wind.fitList.length ? med(a.wind.fitList.map(x => x.w)) * 3.6 : null),
    tas_kmh: r4(med(a.tas) * 3.6),
    gz: r4(f && f.ld), vbg_kmh: r4(f && f.vbg), vms_kmh: r4(f && f.vms), wmin: r4(f && f.wms),
    gz_410m: r4(fd && fd.ld), vbg_410m_kmh: r4(fd && fd.vbg),
    tek_median: r4(tn && med(tn.tek)), netto_median: r4(tn && tn.net10 && med(tn.net10)),
    klappenpaare: paare.map(p => `${p.l}/${p.r}:${p.art}`),
  };
}
module.exports = { kennzahlen };
