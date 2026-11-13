// Klappenstellung aus den geloggten Servokanälen (K1…K64, Ethos −1024…+1024).
// Jedes Klappenpaar (links/rechts) zerfällt in zwei Anteile:
//   gleichsinnig (Wölbung/Flugphase, Butterfly) und gegensinnig (Querruder).
// Welcher Anteil die Summe und welcher die Differenz der Kanäle ist, hängt davon ab, ob die Servos gespiegelt eingebaut sind;
// das erkennt die Rechnung selbst: der Anteil, der dem Querruderknüppel folgt, ist das Querruder, der andere die Wölbung.
// Aus der Wölbung je Paar werden die Klappenstellungen eines Modells gesucht (z. B. Speed, Normal, Thermik),
// damit die Polare je Stellung gerechnet werden kann. Reine Rechnung (window.MMFA.klappen bzw. require).
(function (root) {
  'use strict';

  // tol: Toleranz einer Stellung (% Servoweg je Paar); minShare: kleinster Zeitanteil einer Stellung; smooth: Glättung ± s
  const KLAPPEN = { tol: 4, minShare: 0.03, smooth: 1, minStd: 20, minQr: 0.9 };
  const PCT = 100 / 1024;

  function corr(a, b) {
    let n = 0, sa = 0, sb = 0;
    for (let i = 0; i < a.length; i++) if (!isNaN(a[i]) && !isNaN(b[i])) { sa += a[i]; sb += b[i]; n++; }
    if (n < 10) return NaN;
    const ma = sa / n, mb = sb / n; let sab = 0, saa = 0, sbb = 0;
    for (let i = 0; i < a.length; i++) if (!isNaN(a[i]) && !isNaN(b[i])) { const x = a[i] - ma, y = b[i] - mb; sab += x * y; saa += x * x; sbb += y * y; }
    return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : NaN;
  }
  function std(a) {
    let n = 0, s = 0, q = 0; for (const x of a) if (!isNaN(x)) { s += x; q += x * x; n++; }
    return n > 1 ? Math.sqrt(Math.max(0, q / n - (s / n) ** 2)) : 0;
  }

  // Zerlegung eines Paars: {quer, woelb} als Reihen; art 'diff' = Wölbung ist (L − R)/2 (Servos gespiegelt), 'sum' = (L + R)/2
  function zerlege(L, R, art) {
    const n = L.length, s = new Array(n), d = new Array(n);
    for (let i = 0; i < n; i++) { s[i] = (L[i] + R[i]) / 2; d[i] = (L[i] - R[i]) / 2; }
    return art === 'sum' ? { woelb: s, quer: d } : { woelb: d, quer: s };
  }

  // Vorschlag der Klappenpaare aus einem Log: kanaele = {K1: [...], …}, qr = Querruderknüppel.
  // Ein Paar ist es, wenn ein Anteil (Summe oder Differenz) fast genau dem Querruderknüppel folgt (|r| ≥ minQr)
  // und der andere kaum. Ergebnis: [{l, r, art, qr}] nach Kanalnummer sortiert.
  function vorschlag(kanaele, qr, P = KLAPPEN) {
    const names = Object.keys(kanaele).filter(k => std(kanaele[k]) >= P.minStd);
    const cand = [];
    for (let a = 0; a < names.length; a++) for (let b = a + 1; b < names.length; b++) {
      const L = kanaele[names[a]], R = kanaele[names[b]];
      for (const art of ['diff', 'sum']) {
        const z = zerlege(L, R, art), cq = Math.abs(corr(z.quer, qr)), cw = Math.abs(corr(z.woelb, qr));
        if (cq >= P.minQr && !(cw > 0.5)) cand.push({ l: names[a], r: names[b], art, qr: cq });
      }
    }
    cand.sort((x, y) => y.qr - x.qr);
    const used = new Set(), out = [];
    for (const c of cand) { if (used.has(c.l) || used.has(c.r)) continue; used.add(c.l); used.add(c.r); out.push(c); }
    const num = k => +k.replace(/\D/g, '') || 0;
    return out.sort((x, y) => num(x.l) - num(y.l));
  }

  function glaette(t, v, half) {
    const n = t.length, o = new Array(n).fill(NaN); let j = 0, k = 0, s = 0, c = 0;
    const ok = i => !isNaN(t[i]) && !isNaN(v[i]);
    for (let i = 0; i < n; i++) {
      if (isNaN(t[i])) continue;
      while (k < n && (isNaN(t[k]) || t[k] <= t[i] + half)) { if (ok(k)) { s += v[k]; c++; } k++; }
      while (j < k && (isNaN(t[j]) || t[j] < t[i] - half)) { if (ok(j)) { s -= v[j]; c--; } j++; }
      if (c > 0) o[i] = s / c;
    }
    return o;
  }

  // Wölbung je Paar in % Servoweg, geglättet: Array der Paare, je eine Reihe. paare = [{l, r, art}], kanaele = {K1: [...]}
  function woelbung(t, kanaele, paare, P = KLAPPEN) {
    return paare.map(p => {
      const L = kanaele[p.l], R = kanaele[p.r]; if (!L || !R) return null;
      const w = zerlege(L, R, p.art || 'diff').woelb.map(x => x * PCT);
      return glaette(t, w, P.smooth);
    });
  }

  // Vektor der Wölbung in Zeile i (null, wenn ein Paar fehlt)
  const vektor = (W, i) => { const v = W.map(r => r ? r[i] : NaN); return v.some(isNaN) ? null : v; };
  const abst = (a, b) => { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };

  // Klappenstellungen aus Wölbungs-Vektoren (z. B. eine Probe je Sekunde Gleitflug). Gesucht sind die Häufungen
  // (Mean-Shift auf einem 1-%-Raster, Fenster ± tol je Paar): jede Häufung ist eine Stellung, Mitte = Schwerpunkt.
  // Stellungen unter minShare der Proben fallen weg (Übergänge, Butterfly, Querruder-Spitzen).
  // Ergebnis nach Wölbung sortiert (kleinste Summe zuerst): [{mitte, n, anteil}]
  function stellungen(vecs, P = KLAPPEN) {
    const cells = new Map(); let total = 0;
    for (const v of vecs) {
      if (!v) continue; total++;
      const q = v.map(x => Math.round(x)), k = q.join('/');
      const c = cells.get(k); if (c) c.n++; else cells.set(k, { v: q, n: 1 });
    }
    if (!total) return [];
    const list = [...cells.values()], tol = P.tol;
    const shift = c0 => {
      let c = c0.slice();
      for (let it = 0; it < 50; it++) {
        const s = new Array(c.length).fill(0); let w = 0;
        for (const e of list) if (abst(e.v, c) <= tol) { w += e.n; e.v.forEach((x, i) => s[i] += x * e.n); }
        const nc = s.map(x => x / w), mv = abst(nc, c); c = nc; if (mv < 0.05) break;
      }
      return c;
    };
    const modes = [];
    for (const e of list) {
      const m = shift(e.v), hit = modes.find(o => abst(o.c, m) <= tol / 2);
      if (hit) hit.n += e.n; else modes.push({ c: m, n: e.n });
    }
    return modes.filter(m => m.n / total >= P.minShare)
      .map(m => ({ mitte: m.c.map(x => +x.toFixed(1)), n: m.n, anteil: m.n / total }))
      .sort((a, b) => a.mitte.reduce((s, x) => s + x, 0) - b.mitte.reduce((s, x) => s + x, 0));
  }

  // Nächste Stellung zum Vektor innerhalb tol, sonst −1
  function stellungVon(v, st, tol = KLAPPEN.tol) {
    if (!v) return -1; let best = -1, bd = Infinity;
    st.forEach((s, i) => { const d = s.mitte.length === v.length ? abst(v, s.mitte) : Infinity; if (d < bd) { bd = d; best = i; } });
    return bd <= tol ? best : -1;
  }

  // Gehört der Vektor zur Stellung (Mitte ± tol)?
  const passt = (v, mitte, tol = KLAPPEN.tol) => !!v && v.length === mitte.length && abst(v, mitte) <= tol;

  const api = { KLAPPEN, PCT, corr, std, zerlege, vorschlag, woelbung, vektor, stellungen, stellungVon, passt };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.MMFA = root.MMFA || {}; root.MMFA.klappen = api; }
})(typeof self !== 'undefined' ? self : this);
