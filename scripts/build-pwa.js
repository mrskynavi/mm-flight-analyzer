// Baut site/ aus web/index.html als installierbare Web-App (PWA): Chart.js lokal, Manifest, Icons,
// Service Worker für Offline-Betrieb und Anpassungen für Handy und Tablet. web/index.html bleibt unverändert.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const root = path.join(__dirname, '..');
const out = path.join(root, 'site');
const pwa = path.join(root, 'pwa');
const version = require(path.join(root, 'package.json')).version;
// --ohne-beispiel: für die öffentliche Version, das Beispiel-Log enthält eine echte GPS-Spur
const sample = !process.argv.includes('--ohne-beispiel');
// --beispiel-verschoben: Beispiel-Log mit an einen anderen Ort verschobener GPS-Spur (Form, Höhen und Wind bleiben gleich)
const shifted = process.argv.includes('--beispiel-verschoben');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'icons'), { recursive: true });

let html = fs.readFileSync(path.join(root, 'web', 'index.html'), 'utf8');
const cdn = /<script src="https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/Chart\.js\/[^"]+"><\/script>/;
if (!cdn.test(html)) throw new Error('Chart.js-Einbindung in web/index.html nicht gefunden');
html = html.replace(cdn, '<script src="chart.umd.min.js"></script>');
// Lua-VM für den Simulator ebenfalls lokal
const luaCdn = /<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/fengari-web@[^"]+"><\/script>/;
if (!luaCdn.test(html)) throw new Error('fengari-Einbindung in web/index.html nicht gefunden');
html = html.replace(luaCdn, '<script src="fengari-web.js"></script>');

const head = `
<link rel="manifest" href="manifest.webmanifest">
<link rel="icon" type="image/png" sizes="32x32" href="icons/favicon-32.png">
<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">
<meta name="theme-color" content="#eef1f4" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0f141a" media="(prefers-color-scheme: dark)">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="MM Flight Analyzer">
<meta name="apple-mobile-web-app-status-bar-style" content="default">`;
if (!html.includes('</title>')) throw new Error('<title> in web/index.html nicht gefunden');
html = html.replace('</title>', '</title>' + head);

// Handy/Tablet: Ordner-Auswahl gibt es dort nicht. Android graut .csv-Dateien mit unpassendem
// Dateityp sonst aus, darum dort ohne Filter (addFiles nimmt ohnehin nur .csv).
const tail = `
<script>
(function(){
  var ua = navigator.userAgent, ios = /iPad|iPhone|iPod/.test(ua) || (ua.includes('Mac') && navigator.maxTouchPoints > 1);
  var android = /Android/i.test(ua), mobile = ios || android;
  var app = !!(window.Capacitor && Capacitor.isNativePlatform && Capacitor.isNativePlatform());
  var dir = 'webkitdirectory' in document.createElement('input');
  if (mobile || !dir) { var b = document.getElementById('pickFolder'); if (b) b.hidden = true; }
  if (android) { var f = document.getElementById('file'); if (f) f.removeAttribute('accept'); }
  if (mobile) document.querySelectorAll('#importDlg p.hint').forEach(function(p){ p.hidden = true; });
  var v = document.getElementById('setVer'); if (v && !window.ethosDesktop) v.textContent = (app ? 'Android-App ' : 'Web-App ') + '${version}';
  // in der Android-App liegen alle Dateien schon im Paket, ein Service Worker würde nur alte Stände festhalten
  if ('serviceWorker' in navigator && location.protocol !== 'file:' && !app)
    window.addEventListener('load', function(){ navigator.serviceWorker.register('sw.js').catch(function(e){ console.warn('Service Worker:', e); }); });
})();
</script>
`;
// OneDrive: nur mit Client-ID der App-Registrierung bei Microsoft (pwa/config.json oder ONEDRIVE_CLIENT_ID)
const cfg = JSON.parse(fs.readFileSync(path.join(pwa, 'config.json'), 'utf8'));
const clientId = process.env.ONEDRIVE_CLIENT_ID || cfg.onedriveClientId || '';
const od = clientId ? `<script>window.ETHOS_ONEDRIVE = ${JSON.stringify({ clientId })};</script>
<script src="msal-browser.min.js"></script>
<script src="onedrive.js"></script>
` : '';
html = html.trimEnd() + '\n' + tail + od;

fs.writeFileSync(path.join(out, 'index.html'), html);
fs.copyFileSync(path.join(root, 'node_modules', 'chart.js', 'dist', 'chart.umd.js'), path.join(out, 'chart.umd.min.js'));
fs.copyFileSync(path.join(root, 'node_modules', 'fengari-web', 'dist', 'fengari-web.js'), path.join(out, 'fengari-web.js'));
fs.copyFileSync(path.join(pwa, 'manifest.webmanifest'), path.join(out, 'manifest.webmanifest'));
if (clientId) {
  fs.copyFileSync(path.join(root, 'node_modules', '@azure', 'msal-browser', 'lib', 'msal-browser.min.js'), path.join(out, 'msal-browser.min.js'));
  fs.copyFileSync(path.join(pwa, 'onedrive.js'), path.join(out, 'onedrive.js'));
}
const icons = fs.readdirSync(path.join(pwa, 'icons'));
for (const f of icons) fs.copyFileSync(path.join(pwa, 'icons', f), path.join(out, 'icons', f));
if (sample && fs.existsSync(path.join(root, 'web', 'beispiel.csv'))) {
  let csv = fs.readFileSync(path.join(root, 'web', 'beispiel.csv'), 'utf8');
  if (shifted) {
    // erste Position landet über dem Neuenburgersee, alle anderen um denselben Betrag verschoben
    const first = /(?:^|,)(-?\d+\.\d+) (-?\d+\.\d+)(?=,)/m.exec(csv);
    if (!first) throw new Error('Keine GPS-Position im Beispiel-Log gefunden');
    const dLat = 46.9 - Number(first[1]), dLon = 6.85 - Number(first[2]);
    csv = csv.replace(/(^|,)(-?\d+\.\d+) (-?\d+\.\d+)(?=,)/gm, (m, p, la, lo) => `${p}${(Number(la) + dLat).toFixed(la.split('.')[1].length)} ${(Number(lo) + dLon).toFixed(lo.split('.')[1].length)}`);
  }
  fs.writeFileSync(path.join(out, 'beispiel.csv'), csv);
}
fs.writeFileSync(path.join(out, '.nojekyll'), '');

// Offline-Grundausstattung; das Beispiel-Log (2,7 MB) wird erst beim ersten Laden gemerkt
const shell = ['./', 'index.html', 'chart.umd.min.js', 'fengari-web.js', 'manifest.webmanifest', ...icons.map(f => 'icons/' + f),
  ...(clientId ? ['msal-browser.min.js', 'onedrive.js'] : [])];
const hash = crypto.createHash('sha256');
for (const f of shell.slice(1)) hash.update(fs.readFileSync(path.join(out, f)));
const sw = fs.readFileSync(path.join(pwa, 'sw.js'), 'utf8')
  .replace('__VERSION__', version + '-' + hash.digest('hex').slice(0, 10))
  .replace('__SHELL__', JSON.stringify(shell));
fs.writeFileSync(path.join(out, 'sw.js'), sw);
console.log('site/ vorbereitet' + (clientId ? ' (mit OneDrive)' : ' (ohne OneDrive, keine Client-ID)'));
