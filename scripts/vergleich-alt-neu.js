// Prüft, dass die Rechnungen nach dem Umzug in web/core/ dasselbe liefern wie vorher:
// lädt den alten Stand von web/index.html (git, Standard HEAD~0 vor den Änderungen: Argument --alt <ref>) und den aktuellen
// im Browser, liest dieselben Logs und vergleicht alle berechneten Spalten und die Polare.
// Aufruf: node scripts/vergleich-alt-neu.js --alt <git-ref> <log.csv> …   (braucht Playwright, chart.js und fengari-web in node_modules)
const fs = require('fs'), path = require('path'), { execSync } = require('child_process');
const { chromium } = require('playwright');
const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2); const ai = args.indexOf('--alt'); const ref = ai >= 0 ? args.splice(ai, 2)[1] : 'main';
const mods = process.env.MMFA_NODE_MODULES || path.join(ROOT, 'node_modules');
const CHART = fs.readFileSync(path.join(mods, 'chart.js', 'dist', 'chart.umd.js'), 'utf8');
const LUA = fs.readFileSync(path.join(mods, 'fengari-web', 'dist', 'fengari-web.js'), 'utf8');
const OLD = execSync(`git show ${ref}:web/index.html`, { cwd: ROOT, maxBuffer: 1 << 26 }).toString();

async function rechne(browser, html, logs) {
  const ctx = await browser.newContext();
  await ctx.route('**/*', async r => {
    const u = new URL(r.request().url());
    if (u.hostname === 'cdnjs.cloudflare.com') return r.fulfill({ body: CHART, contentType: 'application/javascript' });
    if (u.hostname === 'cdn.jsdelivr.net') return r.fulfill({ body: LUA, contentType: 'application/javascript' });
    if (u.hostname === 'app.local') {
      const f = u.pathname === '/' ? 'index.html' : u.pathname.slice(1);
      if (f === 'index.html') return r.fulfill({ body: html, contentType: 'text/html' });
      return r.fulfill({ path: path.join(ROOT, 'web', f) });
    }
    return r.abort();
  });
  const page = await ctx.newPage(); const errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.goto('http://app.local/'); await page.waitForTimeout(500);
  if (errs.length) throw new Error('Seitenfehler: ' + errs.join('; '));
  const out = {};
  for (const f of logs) {
    out[path.basename(f)] = await page.evaluate(text => {
      const log = parseCSV(text), ch = channels(log); addDerived(log, ch);
      const cols = {}; for (const c of log.cols.filter(c => c.derived)) cols[c.key] = Array.from(c.vals);
      const pts = polarPoints(log), fit = polarFit(polarBins(pts));
      return { cols, net3: log.net3 ? Array.from(log.net3) : null, pts: pts.map(p => [p[0], p[1]]), fit: fit && { A: fit.A, B: fit.B, ld: fit.ld, vbg: fit.vbg, vms: fit.vms } };
    }, fs.readFileSync(f, 'utf8'));
  }
  await ctx.close(); return out;
}
const diff = (a, b) => { if (!a || !b) return a === b ? 0 : Infinity; if (a.length !== b.length) return Infinity; let m = 0;
  for (let i = 0; i < a.length; i++) { const x = a[i], y = b[i]; if (isNaN(x) !== isNaN(y)) return Infinity; if (!isNaN(x)) m = Math.max(m, Math.abs(x - y)); } return m; };

(async () => {
  const browser = await chromium.launch();
  const alt = await rechne(browser, OLD, args), neu = await rechne(browser, fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8'), args);
  await browser.close();
  let worst = 0;
  for (const f of Object.keys(alt)) {
    const a = alt[f], b = neu[f], keys = [...new Set([...Object.keys(a.cols), ...Object.keys(b.cols)])], rows = [];
    for (const k of keys) { const d = diff(a.cols[k], b.cols[k]); worst = Math.max(worst, d); if (d > 0) rows.push(`${k} ${d.toExponential(1)}`); }
    const dp = diff(a.pts.flat(), b.pts.flat()), dn = diff(a.net3, b.net3); worst = Math.max(worst, dp, dn);
    console.log(`${f}: ${keys.length} Spalten, ${a.pts.length}/${b.pts.length} Gleitpunkte, max. Abweichung Punkte ${dp.toExponential(1)}, Netto3 ${dn.toExponential(1)}` +
      `, GZ ${a.fit?.ld?.toFixed(4)} / ${b.fit?.ld?.toFixed(4)}${rows.length ? ' · ' + rows.join(', ') : ''}`);
  }
  console.log(worst < 1e-9 ? 'GLEICH (Abweichung unter 1e-9)' : `ABWEICHUNG ${worst}`);
  process.exit(worst < 1e-9 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(2); });
