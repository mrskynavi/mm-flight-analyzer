// Wind, TAS und Navigation aus GPS: Nachbau der Lua-Widgets „GPS Course“ und „Wind Estimator“.
// Reine Rechnung ohne Oberfläche, läuft im Browser (window.MMFA.wind) und in Node (require).
// Gemeinsamer Rechenkern: Flight Analyzer, später Plane Analyzer und als Vorlage für die Lua-Widgets.
(function (root) {
  'use strict';

  const D2R = Math.PI / 180, R2D = 180 / Math.PI;

  // Azimut von Punkt 1 nach Punkt 2 in Grad (0 = Nord, im Uhrzeigersinn)
  function bearingDeg(lat1, lon1, lat2, lon2) {
    const p1 = lat1 * D2R, p2 = lat2 * D2R, dl = (lon2 - lon1) * D2R;
    const y = Math.sin(dl) * Math.cos(p2), x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    let b = Math.atan2(y, x) * R2D; if (b < 0) b += 360; return b;
  }
  // Waagrechte Distanz in m (flache Erde, auf ein paar km genau genug)
  function distanceM(lat1, lon1, lat2, lon2) {
    const dLat = (lat2 - lat1) * D2R, dLon = (lon2 - lon1) * D2R * Math.cos((lat1 + lat2) / 2 * D2R);
    return Math.sqrt(dLat * dLat + dLon * dLon) * 6371000;
  }

  // GPS Course: Kurs = Azimut zum letzten Fix, erst ab 3 m Abstand.
  // Ethos loggt Breite und Länge als zwei Telemetriewerte, die oft nicht in derselben Zeile neu sind
  // (rund ein Drittel der Fixe). Ein halber Fix liegt neben der Spur und verdreht den Kurs um bis zu 45°.
  // Darum gilt ein Fix erst, wenn beide Werte neu sind, oder HALF_FIX_WAIT s nach der ersten Änderung
  // (genau Nord/Süd oder Ost/West ändert sich nur ein Wert).
  const COURSE = { minFixDistance: 3.0, halfFixWait: 0.8 };
  // t: Zeit in s je Zeile, gps: [lat, lon] oder null je Zeile
  function gpsCourse(t, gps) {
    const n = t.length, out = new Array(n).fill(NaN);
    let lastLat = null, lastLon = null, course = NaN, prev = null, newLat = false, newLon = false, pendT = null;
    for (let i = 0; i < n; i++) {
      const g = gps[i];
      if (g) {
        if (!prev || g[0] !== prev[0]) newLat = true;
        if (!prev || g[1] !== prev[1]) newLon = true;
        if ((newLat || newLon) && pendT == null) pendT = t[i];
        prev = g;
        if (pendT != null && ((newLat && newLon) || t[i] - pendT >= COURSE.halfFixWait)) {
          newLat = newLon = false; pendT = null;
          if (lastLat != null) {
            if (distanceM(lastLat, lastLon, g[0], g[1]) >= COURSE.minFixDistance) { course = bearingDeg(lastLat, lastLon, g[0], g[1]); lastLat = g[0]; lastLon = g[1]; }
          } else { lastLat = g[0]; lastLon = g[1]; }
        }
      }
      out[i] = course;
    }
    return out;
  }

  // Wind Estimator: Ringpuffer der letzten 40 Bodenvektoren (alle 0,7 s), Kasa-Kreisfit jede Sekunde,
  // nur bei genügend Kursstreuung und plausiblem Ergebnis. Das Log wird in 0,1-s-Schritten „abgespielt“,
  // wie Ethos wakeup() aufruft; zwischen zwei Logzeilen gelten die letzten Werte.
  // Sperren gegen falschen Wind: der erste Fit braucht ein volles Fenster (beim Start passt mit wenigen Stützwerten
  // oft ein falscher Kreis), und der Wind ist der Median (Ost und Nord getrennt) der letzten `median` guten Fits,
  // damit einzelne Ausreisser nicht durchschlagen.
  // maxSpreadR 0.3 wie Sollfahrt-Widget 1.2: Fit nur bei echtem Kreisen (~270° Kurswechsel im Fenster). Mit 0.85 reichte
  // eine einzelne 90°-Kurve; dann liegen nur zwei Punktgruppen im Fenster, durch die fast jeder Kreis passt, und der Wind wird zu hoch.
  const WIND = { windowSize: 40, sampleInterval: 0.7, minSpeed: 2 /* km/h */, minSamples: 10, fitInterval: 1.0, maxSpreadR: 0.3,
    maxTasFactor: 2.0, maxWindFactor: 1.0, maxResidualFrac: 0.25, tick: 0.1, median: 5 };

  const med = a => { const b = [...a].sort((x, y) => x - y), m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };

  // Kreis durch die Punkte (x, y) nach Kasa (algebraisch, kleinste Quadrate); null, wenn die Punkte auf einer Linie liegen
  function kasaFit(x, y, n) {
    let sx = 0, sy = 0; for (let i = 0; i < n; i++) { sx += x[i]; sy += y[i]; }
    const mx = sx / n, my = sy / n; let Suu = 0, Svv = 0, Suv = 0, Suuu = 0, Svvv = 0, Suvv = 0, Svuu = 0;
    for (let i = 0; i < n; i++) { const u = x[i] - mx, v = y[i] - my, uu = u * u, vv = v * v; Suu += uu; Svv += vv; Suv += u * v; Suuu += uu * u; Svvv += vv * v; Suvv += u * vv; Svuu += v * uu; }
    const detA = Suu * Svv - Suv * Suv, scale = Suu + Svv;
    if (scale <= 0 || Math.abs(detA) < 1e-6 * scale * scale) return null;
    const rhs1 = (Suuu + Suvv) / 2, rhs2 = (Svvv + Svuu) / 2;
    const uc = (rhs1 * Svv - rhs2 * Suv) / detA, vc = (Suu * rhs2 - Suv * rhs1) / detA;
    const r2 = uc * uc + vc * vc + (Suu + Svv) / n; if (r2 < 0) return null;
    return { cx: uc + mx, cy: vc + my, r: Math.sqrt(r2) };
  }
  // Kursstreuung: Länge des mittleren Einheitsvektors (0 = alle Richtungen gleich oft, 1 = alle gleich)
  function courseSpreadOk(x, y, n, maxR = WIND.maxSpreadR) {
    let sc = 0, ss = 0; for (let i = 0; i < n; i++) { const m = Math.hypot(x[i], y[i]); if (m > 1e-6) { sc += x[i] / m; ss += y[i] / m; } }
    return Math.hypot(sc, ss) / n < maxR;
  }
  function fitIsPlausible(f, x, y, n, P = WIND) {
    if (!f || f.r <= 1e-3) return false;
    let maxG = 0; for (let i = 0; i < n; i++) maxG = Math.max(maxG, Math.hypot(x[i], y[i]));
    if (maxG <= 1e-3 || f.r > P.maxTasFactor * maxG || Math.hypot(f.cx, f.cy) > P.maxWindFactor * maxG) return false;
    let sq = 0; for (let i = 0; i < n; i++) { const d = Math.hypot(x[i] - f.cx, y[i] - f.cy) - f.r; sq += d * d; }
    return Math.sqrt(sq / n) <= P.maxResidualFrac * f.r;
  }

  // t: Zeit (s), speed: Grundgeschwindigkeit (beliebige Einheit), course: Kurs über Grund (°), minSpeed in derselben Einheit wie speed.
  // Ergebnis je Zeile: W Windstärke (Einheit von speed; 0 vor dem ersten Fit), D Richtung, aus der der Wind kommt (°),
  // TAS = |Bodenvektor − Windvektor|, ok = 1 sobald ein Fit da ist; fits = Anzahl guter Fits, fitList = {row, w, d} je Fit.
  function windEstimator(t, speed, course, minSpeed, opts) {
    const P = Object.assign({}, WIND, opts || {});
    const n = t.length, W = new Array(n).fill(NaN), D = new Array(n).fill(NaN), TAS = new Array(n).fill(NaN), OK = new Uint8Array(n);
    const bx = [], by = []; let bufN = 0, head = 0, lastSample = -Infinity, lastFit = -Infinity;
    let windSpeed = 0, windDirFrom = 0, haveFit = false, tas = NaN, fits = 0, row = 0; const fitList = [];
    const recent = [];
    const tEndV = t.filter(x => !isNaN(x)).pop() || 0;
    const ticks = Math.ceil(tEndV / P.tick) + 1;
    for (let k = 0; k <= ticks; k++) {
      const now = k * P.tick;
      while (row < n - 1 && !(t[row + 1] > now)) row++;           // letzte Logzeile bis „jetzt“
      const sp = speed[row], cs = course[row], ok = !isNaN(sp) && !isNaN(cs);
      if (now - lastSample >= P.sampleInterval && ok && sp >= minSpeed) {
        bx[head] = sp * Math.sin(cs * D2R); by[head] = sp * Math.cos(cs * D2R);
        head = (head + 1) % P.windowSize; if (bufN < P.windowSize) bufN++; lastSample = now;
      }
      if (now - lastFit >= P.fitInterval && bufN >= (haveFit ? P.minSamples : P.windowSize)) {
        lastFit = now;
        if (courseSpreadOk(bx, by, bufN, P.maxSpreadR)) {
          const f = kasaFit(bx, by, bufN);
          if (fitIsPlausible(f, bx, by, bufN, P)) {
            recent.push(f); if (recent.length > P.median) recent.shift();
            const cx = med(recent.map(q => q.cx)), cy = med(recent.map(q => q.cy));
            windSpeed = Math.hypot(cx, cy);
            let to = Math.atan2(cx, cy) * R2D; if (to < 0) to += 360;
            windDirFrom = (to + 180) % 360; haveFit = true; fits++; fitList.push({ row, w: windSpeed, d: windDirFrom });
          }
        }
      }
      if (ok) {
        const gr = cs * D2R, wr = (windDirFrom + 180) * D2R;
        tas = Math.hypot(sp * Math.sin(gr) - windSpeed * Math.sin(wr), sp * Math.cos(gr) - windSpeed * Math.cos(wr));
      }
      // Werte am Ende dieser Logzeile festhalten
      if (row + 1 >= n || t[row + 1] > now + P.tick - 1e-9) { W[row] = haveFit ? windSpeed : 0; D[row] = haveFit ? windDirFrom : 0; TAS[row] = tas; OK[row] = haveFit ? 1 : 0; }
    }
    return { W, D, TAS, OK, fits, fitList };
  }

  // Steuerkurs = Richtung des Luftvektors (Bodenvektor minus Windvektor); Drift = Kurs über Grund minus Steuerkurs;
  // Gegenwind = Windanteil gegen die Flugrichtung (negativ = Rückenwind). Unter minSpeed ist der Kurs zufällig, dort keine Werte.
  function nav(speed, crs, W, D, minSpeed) {
    const n = speed.length, H = new Array(n).fill(NaN), DR = new Array(n).fill(NaN), HW = new Array(n).fill(NaN);
    for (let i = 0; i < n; i++) {
      const sp = speed[i], cs = crs[i], w = W[i], d = D[i];
      if (isNaN(sp) || isNaN(cs) || isNaN(w) || sp < minSpeed) continue;
      const wr = (d + 180) * D2R, ax = sp * Math.sin(cs * D2R) - w * Math.sin(wr), ay = sp * Math.cos(cs * D2R) - w * Math.cos(wr);
      if (Math.hypot(ax, ay) < 1e-3) continue;
      const h = (Math.atan2(ax, ay) * R2D + 360) % 360;
      H[i] = h; DR[i] = ((cs - h + 540) % 360) - 180; HW[i] = w * Math.cos((d - h) * D2R);
    }
    return { H, DR, HW };
  }

  const api = { D2R, R2D, COURSE, WIND, bearingDeg, distanceM, gpsCourse, kasaFit, courseSpreadOk, fitIsPlausible, windEstimator, nav, med };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.MMFA = root.MMFA || {}; root.MMFA.wind = api; }
})(typeof self !== 'undefined' ? self : this);
