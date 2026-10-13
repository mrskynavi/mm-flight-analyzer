// Erzeugt das Handbuch als PDF: Screenshots aus web/index.html (mit nachgestellter Desktop-App und dem
// Beispiel-Log), Version aus package.json, Changelog aus CHANGELOG.md, Vorlage docs/handbuch/handbuch.html.
// Ergebnis: dist/MM-Flight-Analyzer-Bedienanleitung.pdf. Braucht Playwright mit Chromium und chart.js.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'docs', 'handbuch');
const OUTDIR = path.join(ROOT, 'dist', 'handbuch');
const BILDER = path.join(OUTDIR, 'bilder');
const PDF = path.join(ROOT, 'dist', 'MM-Flight-Analyzer-Bedienanleitung.pdf');
const WEB = path.join(ROOT, 'web');
const VERSION = require(path.join(ROOT, 'package.json')).version;
const NEXT = VERSION.split('.').map((n, i) => i === 1 ? +n + 1 : i === 2 ? 0 : n).join('.');
const CSV = fs.readFileSync(path.join(WEB, 'beispiel.csv'), 'utf8');
const CHART = fs.readFileSync(path.join(ROOT, 'node_modules', 'chart.js', 'dist', 'chart.umd.js'), 'utf8');
const LUA = fs.readFileSync(path.join(ROOT, 'node_modules', 'fengari-web', 'dist', 'fengari-web.js'), 'utf8');
const MOCK = fs.readFileSync(path.join(SRC, 'mock.js'), 'utf8');
let browser;

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const inline = s => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
// CHANGELOG.md: "## Version – Datum" und Aufzählungen mit "- "; leere Abschnitte fallen weg
function changelog() {
  const out = []; let list = false;
  const close = () => { if (list) { out.push('</ul>'); list = false; } };
  for (const line of fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8').split(/\r?\n/)) {
    if (/^## /.test(line)) { close(); out.push(`<h2>${inline(line.slice(3).trim())}</h2>`); }
    else if (/^- /.test(line)) { if (!list) { out.push('<ul>'); list = true; } out.push(`<li>${inline(line.slice(2))}</li>`); }
    else if (/^\s+\S/.test(line) && list) out[out.length - 1] = out[out.length - 1].replace(/<\/li>$/, ' ' + inline(line.trim()) + '</li>');
  }
  close();
  // Überschriften ohne Einträge entfernen
  return out.filter((l, i) => !(l.startsWith('<h2>') && (out[i + 1] || '').startsWith('<h2>') || l.startsWith('<h2>') && i === out.length - 1)).join('\n');
}
// Datum zur Version aus dem Changelog, sonst heute
function stand() {
  const m = new RegExp('^## ' + VERSION.replace(/\./g, '\\.') + '\\s+[–-]\\s+(\\d{4})-(\\d{2})-(\\d{2})', 'm').exec(fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8'));
  const d = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date();
  return d.toLocaleDateString('de-CH', { month: 'long', year: 'numeric' });
}

async function open(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: opts.w || 1280, height: opts.h || 820 }, deviceScaleFactor: 2, locale: opts.locale || 'de-CH', colorScheme: opts.scheme || 'dark', timezoneId: 'Europe/Zurich' });
  await ctx.route('**/*', async r => {
    const u = new URL(r.request().url());
    if (u.hostname === 'cdnjs.cloudflare.com') return r.fulfill({ body: CHART, contentType: 'application/javascript' });
    if (u.hostname === 'cdn.jsdelivr.net' && u.pathname.includes('fengari-web')) return r.fulfill({ body: LUA, contentType: 'application/javascript' });
    if (u.hostname === 'app.local') {
      const f = u.pathname === '/' ? 'index.html' : u.pathname.slice(1);
      if (f === 'beispiel.csv') return r.fulfill({ body: CSV, contentType: 'text/csv' });
      return r.fulfill({ path: path.join(WEB, f) });
    }
    return r.abort();
  });
  await ctx.addInitScript(`window.__MOCK=${JSON.stringify({ version: VERSION, ...(opts.mock || {}) })};`);
  if (opts.mock?.desktop) await ctx.addInitScript({ content: 'window.__CSV=' + JSON.stringify(CSV) + ';' });
  await ctx.addInitScript({ content: MOCK });
  if (opts.storage) await ctx.addInitScript(`for (const [k,v] of Object.entries(${JSON.stringify(opts.storage)})) localStorage.setItem(k,v);`);
  const page = await ctx.newPage();
  page.on('pageerror', e => console.error('PAGEERR', e.message));
  await page.goto('http://app.local/' + (opts.hash ? '#' + opts.hash : ''));
  await page.waitForSelector('.kpi', { timeout: 20000 });
  await page.waitForTimeout(1200);
  return page;
}
// nummerierte Markierungen an Elementen
async function badges(page, list) {
  await page.evaluate(list => {
    document.querySelectorAll('.__b').forEach(e => e.remove());
    for (const [sel, n, pos] of list) {
      const el = document.querySelector(sel); if (!el) { throw new Error('Element fehlt: ' + sel); continue; }
      const r = el.getBoundingClientRect();
      const b = document.createElement('div'); b.className = '__b'; b.textContent = n;
      const p = pos || 'tl';
      let x = p.includes('r') ? r.right - 4 : r.left - 14, y = p.includes('b') ? r.bottom - 10 : r.top - 12;
      if (p === 'l') { x = r.left - 30; y = r.top + r.height / 2 - 12; }
      if (p === 'b') { x = r.left - 12; y = r.bottom - 6; }
      if (p === 'br') { x = r.right - 12; y = r.bottom - 6; }
      if (p === 'rr') { x = r.right + 6; y = r.top + r.height / 2 - 12; }
      Object.assign(b.style, { position: 'absolute', left: (x + scrollX) + 'px', top: (y + scrollY) + 'px', width: '24px', height: '24px', borderRadius: '50%', background: '#e8590c', color: '#fff', font: 'bold 13px/24px sans-serif', textAlign: 'center', zIndex: 99999, boxShadow: '0 0 0 2px #fff, 0 2px 6px rgba(0,0,0,.5)' });
      document.body.appendChild(b);
    }
  }, list);
}
async function shot(page, name, clip) {
  const o = { path: path.join(BILDER, name + '.png') };
  if (clip === 'full') o.fullPage = true; else if (clip) { o.clip = clip; o.fullPage = true; }
  await page.screenshot(o);
  
}
async function clipOf(page, sel, pad = 8) {
  const r = await page.evaluate(sel => { const b = document.querySelector(sel).getBoundingClientRect(); return { x: b.left + scrollX, y: b.top + scrollY, width: b.width, height: b.height }; }, sel);
  return { x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad), width: r.width + 2 * pad, height: r.height + 2 * pad };
}
const D = { desktop: true };
const from = async (p, sel) => { const y = await p.evaluate(s => document.querySelector(s).getBoundingClientRect().top + scrollY - 10, sel); const h = await p.evaluate(() => document.documentElement.scrollHeight); return { x: 0, y, width: 1280, height: h - y }; };
const setCursor = async (p, f) => { const b = await p.locator('#curTrack').boundingBox(); await p.mouse.click(b.x + b.width * f, b.y + b.height / 2); await p.waitForTimeout(400); };

async function screenshots() {
  let p = await open({ mock: D });
  // 1 Hauptfenster mit Nummern
  await badges(p, [['.brand h1', 1, 'l'], ['#infoBtn', 2, 'br'], ['#selModel', 3, 'b'], ['#logBtn', 4, 'b'], ['.logpick .zbtns', 5, 'br'], ['#importBtn', 6, 'b'], ['#openSettings', 7, 'br'], ['#syncDot', 8, 'l'], ['#ejectBtn', 9, 'b'], ['#openArchive', 10, 'br'], ['#tab-uebersicht', 11, 'l'], ['#fileinfo .tag', 12, 'l'], ['#kiOpen', 13, 'b']]);
  await shot(p, '01-hauptfenster', { x: 0, y: 0, width: 1280, height: 420 });
  await badges(p, []);
  await shot(p, '02-uebersicht', 'full');
  // Info
  await p.click('#infoBtn'); await p.waitForTimeout(200);
  await shot(p, '03-info', { x: 0, y: 0, width: 1280, height: 330 });
  await p.click('#infoBtn');
  // Log-Liste
  await p.click('#logBtn'); await p.waitForTimeout(800);
  await shot(p, '04-logliste', { x: 0, y: 0, width: 1280, height: 420 });
  await p.keyboard.press('Escape');
  await p.click('#selModel'); await p.keyboard.press('Escape');
  // Import
  await p.click('#importBtn'); await p.waitForTimeout(300);
  await shot(p, '05-import', await clipOf(p, '#importDlg', 20));
  await p.keyboard.press('Escape');
  // Einstellungen
  await p.click('#openSettings'); await p.waitForTimeout(300); await p.evaluate(() => document.activeElement.blur());
  await shot(p, '06-einstellungen', await clipOf(p, '#settingsDlg', 20));
  // KI-Einstellungen und MCP-Dialog
  await p.click('#openKi'); await p.waitForTimeout(400); await p.evaluate(() => document.activeElement.blur());
  await shot(p, '22-ki-einstellungen', await clipOf(p, '#kiDlg', 20));
  await p.keyboard.press('Escape'); await p.waitForTimeout(200);
  await p.evaluate(() => { const d = document.querySelector('#settingsDlg'); if (!d.open) d.showModal(); });
  await p.click('#openMcp'); await p.waitForTimeout(400); await p.evaluate(() => document.activeElement.blur());
  await shot(p, '23-mcp', await clipOf(p, '#mcpDlg', 20));
  await p.keyboard.press('Escape'); await p.waitForTimeout(200);
  await p.evaluate(() => { for (const d of document.querySelectorAll('dialog[open]')) d.close(); });
  // Zeitpunkt in der Übersicht
  await setCursor(p, 0.4);
  await badges(p, [['#curTrack', 1, 'l'], ['#curPrev', 2, 'b'], ['#curNext', 3, 'br'], ['#curTime', 4, 'br'], ['#curOff', 5, 'br']]);
  await shot(p, '07-zeitpunkt', await clipOf(p, 'section:has(#curOver)', 40));
  await badges(p, []);
  // Diagramme
  await p.click('#tab-diagramme'); await p.waitForTimeout(800);
  await badges(p, [['#chips', 1, 'l'], ['.seg', 2, 'l'], ['.toggle', 3, 'br'], ['#zOut', 4, 'l'], ['#zRange', 5, 'b'], ['.markpick', 6, 'l'], ['#nav', 7, 'l'], ['#curTrack', 8, 'l'], ['.cbox .grip', 9, 'l']]);
  await shot(p, '08-diagramme', { ...(await from(p, '.tabs')), height: 1150 });
  await badges(p, []);
  // KI-Panel neben dem Tab Diagramme
  await p.click('#kiOpen'); await p.waitForTimeout(800); await p.evaluate(() => document.activeElement.blur());
  await shot(p, '24-ki-panel', { x: 0, y: 0, width: 1280, height: 900 });
  await p.click('#kiOpen'); await p.waitForTimeout(300);
  await p.click('[data-info="info-diag"]'); await p.waitForTimeout(200);
  await shot(p, '09-diagramme-info', await clipOf(p, '#info-diag', 12));
  await p.click('[data-info="info-diag"]');
  for (const k of ['VFR 2.4G (%)','GPS-Geschw. (km/h)','ESC Spannung (V)']) await p.click(`.chip[data-k="${k}"]`);
  await p.click('.seg [data-ov="1"]'); await p.waitForTimeout(800);
  await shot(p, '10-ueberlagert', { ...(await from(p, '.chipopts')), height: 700 });
  await p.click('.seg [data-ov="0"]');
  await p.click('#zIn'); await p.click('#zIn'); await p.waitForTimeout(500);
  await shot(p, '11-zoom', { ...(await from(p, '.chipopts')), height: 900 });
  // Filter (Höhe 100–430 m) und Gleitzahl
  await p.click('#zAll');
  const only = async keep => { const st = await p.$$eval('#chips .chip', cs => cs.map(c => [c.dataset.k, c.getAttribute('aria-pressed') === 'true']));
    for (const [k, on] of st) if (on !== keep.includes(k)) { await p.click(`.chip[data-k="${k.replace(/"/g, '\\"')}"]`); await p.waitForTimeout(50); } };
  await only(['Altitude (m)', 'Steigr. Vario (m/s)', 'Gleitzahl']); await p.waitForTimeout(300);
  await p.evaluate(() => { addFilter('Altitude (m)'); const f = FILTERS[0]; f.lo = 100; f.hi = 430; syncFilter(f); applyFilters(); document.activeElement.blur(); });
  await p.waitForTimeout(800);
  await shot(p, '21-filter', { ...(await from(p, '#filters')), height: 980 });
  await p.evaluate(() => { FILTERS.length = 0; renderFilters(); applyFilters(); });
  // Thermik
  await p.click('#tab-steigen'); await p.waitForTimeout(900);
  await shot(p, '12-thermik', await from(p, '#curbar'));
  // Karte
  await p.click('#tab-karte'); await p.waitForTimeout(1200);
  await shot(p, '13-karte', await from(p, '#curbar'));
  // Alle Werte
  await p.click('#tab-werte'); await p.waitForTimeout(500);
  await shot(p, '14-werte', { ...(await from(p, '#curbar')), height: 760 });
  // Rohdaten
  await p.click('#tab-rohdaten'); await p.waitForTimeout(800);
  await shot(p, '15-rohdaten', { ...(await from(p, '#curbar')), height: 640 });
  // Polare mit dem Block für MacCready (legt auch die Polare fürs Sollfahrt-Widget im Simulator ab)
  await p.click('#tab-polare'); await p.waitForTimeout(1500);
  await shot(p, '25-polare', { ...(await from(p, '#curbar')), height: 900 });
  await p.evaluate(() => { const r = document.querySelector('#mcMc'); r.value = 1; r.dispatchEvent(new Event('input', { bubbles: true })); });
  await p.waitForTimeout(600);
  await shot(p, '26-maccready', { ...(await clipOf(p, '#mcBox', 8)), height: 700 });
  // Simulator: Sollfahrt-Widget mit dem Beispiel-Log bei 20:00
  await p.click('#tab-simulator'); await p.waitForTimeout(1500);
  await p.evaluate(() => { const s = document.querySelector('#simSel'); const o = [...s.options].find(o => /sollfahrt/i.test(o.text)); if (o) { s.value = o.value; s.dispatchEvent(new Event('change')); } });
  await p.waitForTimeout(800);
  await p.fill('#simGotoIn', '20:00'); await p.press('#simGotoIn', 'Enter');
  await p.waitForFunction(() => document.querySelector('#simProg').hidden, null, { timeout: 120000 }); await p.waitForTimeout(1500);
  await badges(p, [['#simSrcSeg', 1, 'b'], ['#simSel', 2, 'b'], ['#simSize', 3, 'b'], ['#simForm', 4, 'l'], ['#simScr', 5, 'tl'], ['#simTl', 6, 'l'], ['#simPlay', 7, 'b'], ['#simSpeed', 8, 'br']]);
  await shot(p, '27-simulator', { ...(await from(p, '.simbar')), height: 780 });
  await badges(p, []);
  // Eigene Widgets (Dialog unter ⚙)
  await p.click('#openSettings'); await p.waitForTimeout(300);
  await p.click('#openWgt'); await p.waitForTimeout(400); await p.evaluate(() => document.activeElement.blur());
  await shot(p, '28-widgets', await clipOf(p, '#wgtDlg', 20));
  await p.evaluate(() => { for (const d of document.querySelectorAll('dialog[open]')) d.close(); });
  await p.context().close();

  // Sync-Zustände
  p = await open({ mock: D });
  const bar = async (name, s, extra) => { await p.evaluate(s => window.__setSync(s), s); await p.waitForTimeout(300); if (extra) await extra(); await shot(p, name, await clipOf(p, '#syncbar', 6)); };
  const now = Date.parse('2026-10-05T12:31:00+02:00'), base = '/Users/christoph/Library/CloudStorage/OneDrive-Persönlich/Ethos Logs';
  await bar('s-copy', { state: 'copy', total: 12, done: 5, bytes: 100, doneBytes: 44, file: 'SB-10-2026-10-04-15-02-11.csv' });
  await bar('s-done', { state: 'done', connected: true, copied: [{ model: 'SB-10' }, { model: 'SB-10' }, { model: 'PlusX' }], errors: [], at: now });
  await bar('s-none', { state: 'done', connected: true, copied: [], errors: [], at: now });
  await bar('s-ejected', { state: 'done', connected: false, ejected: true, copied: [], errors: [], at: now });
  await bar('s-idle', { state: 'idle' });
  await bar('s-denied', { state: 'denied' });
  await bar('s-off', { state: 'off' });
  await bar('s-error', { state: 'error', error: "ENOENT: Archiv-Ordner nicht gefunden: 'G:\\Meine Ablage\\Ethos Logs'" });
  const intr = { state: 'done', connected: false, interrupted: true, left: 14, archive: base, sources: ['/Volumes/RADIO/logs'], copied: Array.from({ length: 20 }, (_, i) => ({ model: i < 15 ? 'SB-10' : 'PlusX' })), errors: [{ name: 'SB-10-2025-11-15-15-17-22.csv', error: "EIO: i/o error, copyfile '/Volumes/RADIO/logs/SB-10-2025-11-15-15-17-22.csv'" }], at: now };
  await bar('s-interrupted', intr);
  await p.click('#syncInfo'); await p.waitForTimeout(300);
  await shot(p, 's-details', await clipOf(p, '#syncDlg', 20));
  await p.context().close();
  // Update-Hinweis
  p = await open({ mock: { desktop: true, update: { newer: true, latest: NEXT, url: 'https://github.com/mrskynavi/mm-flight-analyzer/releases' } } });
  await shot(p, 's-update', await clipOf(p, '#syncbar', 6));
  await p.context().close();
  // Hell
  p = await open({ mock: D, storage: { 'ethoslv.theme': 'light' } });
  await shot(p, '16-hell', { x: 0, y: 0, width: 1280, height: 700 });
  await p.context().close();
  // Web-Version (ohne Desktop)
  p = await open({});
  await shot(p, '17-web', { x: 0, y: 0, width: 1280, height: 520 });
  await p.click('#openSettings'); await p.waitForTimeout(300);
  await shot(p, '18-web-einstellungen', await clipOf(p, '#settingsDlg', 20));
  await p.context().close();
  // Englisch
  p = await open({ mock: D, storage: { 'ethoslv.lang': 'en' } });
  await shot(p, '19-englisch', { x: 0, y: 0, width: 1280, height: 520 });
  // schmal / Handy
  await p.context().close();
  p = await open({ w: 400, h: 860 });
  await shot(p, '20-handy');
  }

async function main() {
  fs.mkdirSync(BILDER, { recursive: true });
  browser = await chromium.launch();
  try {
    await screenshots();
    fs.copyFileSync(path.join(ROOT, 'build', 'icon.png'), path.join(BILDER, 'icon.png'));
    // feste Bilder (z. B. Widgets am Sender), die nicht aus der App kommen
    for (const f of fs.readdirSync(path.join(SRC, 'fest'))) fs.copyFileSync(path.join(SRC, 'fest', f), path.join(BILDER, f));
    const html = fs.readFileSync(path.join(SRC, 'handbuch.html'), 'utf8')
      .replaceAll('{{VERSION}}', VERSION).replaceAll('{{STAND}}', stand()).replace('{{CHANGELOG}}', changelog());
    if (html.includes('{{')) throw new Error('Platzhalter in handbuch.html nicht ersetzt');
    const file = path.join(OUTDIR, 'index.html');
    fs.writeFileSync(file, html);
    const p = await browser.newPage();
    await p.goto('file://' + file); await p.waitForLoadState('networkidle');
    await p.pdf({ path: PDF, format: 'A4', printBackground: true, displayHeaderFooter: true, margin: { top: '16mm', bottom: '18mm', left: '16mm', right: '16mm' },
      headerTemplate: '<div></div>',
      footerTemplate: `<div style="width:100%;font-size:8px;color:#888;padding:0 16mm;display:flex;justify-content:space-between;font-family:sans-serif"><span>MM Flight Analyzer ${VERSION} · Bedienanleitung</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>` });
  } finally { await browser.close(); }
  console.log('Handbuch erzeugt: ' + path.relative(ROOT, PDF));
}
main().catch(e => { console.error(e); process.exit(1); });
