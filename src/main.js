// Desktop-Hülle: zeigt den MM Flight Analyzer und synchronisiert Logs vom Sender ins Archiv
const { app, BrowserWindow, ipcMain, dialog, shell, net, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const S = require('./sync');
const U = require('./update');
const E = require('./eject');
const M = require('./mcp');
const AI = require('./ai');
const MG = require('./migrate');
const WG = require('./widgets');
const SN = require('./skynav');

// Daten aus dem Ordner der früheren App „Ethos Log Viewer“ übernehmen, bevor irgendetwas den neuen Ordner benutzt
const MIGRATED = MG.migrate(path.join(app.getPath('appData'), MG.OLD_NAME), app.getPath('userData'));

const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json');
const DEFAULTS = () => ({ senderPath: 'Radio/logs', archiveDir: S.defaultArchive(), autoSync: true, archiveManual: false, mcp: false, mcpPort: M.DEFAULT_PORT,
  widgetRepo: WG.DEFAULT_REPO, widgetBranch: WG.DEFAULT_BRANCH, widgetDir: WG.defaultDir(), widgetAuto: true, widgetOff: [] });
let settings;
function loadSettings() {
  try { settings = { ...DEFAULTS(), ...JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8')) }; }
  catch { settings = DEFAULTS(); }
  return settings;
}
function saveSettings(s) {
  settings = { ...settings, ...s };
  fs.mkdirSync(path.dirname(SETTINGS_FILE()), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(settings, null, 2));
  return settings;
}

let win, watcher;
function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 900, minWidth: 420, title: 'MM Flight Analyzer', backgroundColor: '#0f141a',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, '..', 'app', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

// Lesen nur im Archiv und auf dem Sender
function allowed(p) {
  const r = path.resolve(p);
  const roots = [settings.archiveDir, ...(watcher?.synced || [])].map(x => path.resolve(x) + path.sep);
  return roots.some(x => r.startsWith(x));
}

ipcMain.handle('settings:get', () => settings);
ipcMain.handle('settings:set', async (_, s) => {
  const before = mcpWanted();
  const r = saveSettings(s); watcher.synced.clear(); watcher.poll();
  if (mcpWanted() !== before) await restartMcp();
  return r;
});
ipcMain.handle('dialog:folder', async (_, current) => {
  const r = await dialog.showOpenDialog(win, { defaultPath: current || undefined, properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('sync:now', () => watcher.poll(true));
ipcMain.handle('sync:status', () => watcher.status);
// Sender auswerfen: Sync anhalten, alle gefundenen Sender-Laufwerke auswerfen, Ergebnis in den Status
ipcMain.handle('sender:eject', async () => {
  if (watcher.busy) throw new Error('Der Sync läuft noch.');
  const vols = await S.volumes();
  const roots = [...new Set(watcher.roots.map(r => E.volumeOf(r, vols)).filter(Boolean))];
  if (!roots.length) throw new Error('Kein Sender angeschlossen.');
  watcher.paused = true;
  try {
    for (const r of roots) await E.eject(r);
    watcher.roots = []; watcher.ethosRoots = []; watcher.synced.clear();
    watcher.set({ ...watcher.status, connected: false, ejected: true });
  } finally { watcher.paused = false; }
});
// Polaren fürs MacCready-Widget: scripts/maccready/polaren.lua auf jedem angeschlossenen Ethos-Sender
ipcMain.handle('sender:polarsTarget', () => ({ roots: watcher.ethosRoots || [] }));
ipcMain.handle('sender:polars', async (_, text) => {
  const roots = watcher.ethosRoots || [];
  if (!roots.length) throw new Error('Kein Ethos-Sender angeschlossen.');
  const out = [];
  for (const r of roots) out.push(await S.writePolars(r, text));
  return out;
});
// Simulator: scripts-Ordner des angeschlossenen Ethos-Senders oder ein selbst gewählter Ordner
let simDir = null;
async function simScriptsDir(opts) {
  if (opts?.pick) {
    const r = await dialog.showOpenDialog(win, { defaultPath: settings.simScripts || undefined, properties: ['openDirectory'] });
    if (r.canceled) return null;
    saveSettings({ simScripts: r.filePaths[0] });
  }
  if (opts?.sender) saveSettings({ simScripts: '' });
  if (opts?.auto) {   // ohne Auswahl: Widgets auf dem angeschlossenen Sender, sonst die von GitHub (Kopie im Benutzerverzeichnis)
    for (const r of watcher.ethosRoots || []) {
      const d = path.join(r, 'scripts');
      if ((await WG.listWidgets(d)).length) return { dir: d, source: 'sender' };
    }
    if (!wgFetch || Date.now() - wgFetch.at > (wgFetch.ok ? 5 * 60 * 1000 : 60 * 1000)) await fetchWidgets();   // offline nicht bei jedem Öffnen warten
    const d = path.join(settings.widgetDir, 'scripts');
    return (await WG.listWidgets(d)).length ? { dir: d, source: 'github', old: !wgFetch?.ok } : null;
  }
  if (settings.simScripts && fs.existsSync(settings.simScripts)) return { dir: settings.simScripts, source: 'ordner' };
  for (const r of watcher.ethosRoots || []) { const d = path.join(r, 'scripts'); if (fs.existsSync(d)) return { dir: d, source: 'sender' }; }
  return null;
}
ipcMain.handle('scripts:read', async (_, opts) => {
  const t = await simScriptsDir(opts || {});
  if (!t) { simDir = null; return { files: {}, error: opts?.sender ? 'Kein Ethos-Sender mit scripts-Ordner angeschlossen.' : null }; }
  simDir = t.dir; simWatch(t.dir);
  return { ...t, files: await S.readScripts(t.dir) };
});
// scripts-Ordner beobachten: wird ein Widget im Hintergrund neu geschrieben (Editor, git pull, Sync),
// bekommt der Simulator den neuen Stand und startet das Widget an der gleichen Stelle neu
let simWatcher = null, simWatchT = null;
function simWatch(dir) {
  if (simWatcher?.dir === dir) return;
  simWatcher?.close(); simWatcher = null;
  try {
    const w = fs.watch(dir, { recursive: true }, (_, name) => {
      const rel = String(name || '').replace(/\\/g, '/');
      if (rel && rel.split('/').some(x => x.startsWith('.'))) return;   // .git, Editor-Temp
      if (rel && !/\.(lua|txt|json|csv|cfg|ini)$/i.test(rel) && /\.[^/]+$/.test(rel)) return;
      clearTimeout(simWatchT);
      simWatchT = setTimeout(async () => {   // warten, bis fertig geschrieben ist
        if (simDir !== dir || !win || win.isDestroyed()) return;
        win.webContents.send('scripts:changed', { dir, files: await S.readScripts(dir) });
      }, 400);
    });
    w.on('error', () => {});
    w.dir = dir; simWatcher = w;
  } catch { /* Ordner ohne Beobachtung: Änderungen erst nach erneutem Wählen */ }
}
ipcMain.handle('scripts:write', (_, rel, text) => {
  if (!simDir) throw new Error('Kein scripts-Ordner gewählt.');
  return S.writeScript(simDir, String(rel), text);
});
ipcMain.handle('archive:list', () => S.listArchive(settings.archiveDir));
ipcMain.handle('archive:save', (_, name, bytes) => S.archiveFile(settings.archiveDir, name, Buffer.from(bytes)));
ipcMain.handle('archive:open', () => { fs.mkdirSync(settings.archiveDir, { recursive: true }); return shell.openPath(settings.archiveDir); });
// Update-Suche über das Netz von Chromium: nutzt Proxy und Zertifikate des Systems
async function netJson(url) {
  const r = await net.fetch(url, { headers: { 'User-Agent': 'mm-flight-analyzer', Accept: 'application/vnd.github+json' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
// ---------- Eigene Widgets: von GitHub ins Benutzerverzeichnis, beim Anschliessen auf den Sender ----------
async function netBuf(url) {
  const r = await net.fetch(url, { headers: { 'User-Agent': 'mm-flight-analyzer' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.arrayBuffer();
}
let wgFetch = null, wgCopy = null, wgBusy = null;
async function fetchWidgets() {
  if (wgBusy) return wgBusy;
  wgBusy = (async () => {
    try {
      const r = await WG.fetchRepo({ repo: settings.widgetRepo, branch: settings.widgetBranch || 'main', dir: settings.widgetDir, getJson: netJson, getBuf: netBuf });
      wgFetch = { ok: true, ...r };
    } catch (e) {
      const msg = /HTTP 404/.test(e.message) ? `Repo ${settings.widgetRepo} (Zweig ${settings.widgetBranch || 'main'}) nicht gefunden oder nicht öffentlich.` : e.message;
      wgFetch = { ok: false, error: msg, at: Date.now() };
    }
    return wgFetch;
  })();
  try { return await wgBusy; } finally { wgBusy = null; }
}
async function copyWidgets(roots) {
  // vorher frisch holen; ohne Netz wird die letzte Kopie im Benutzerverzeichnis verwendet
  if (!wgFetch || Date.now() - wgFetch.at > 5 * 60 * 1000 || !wgFetch.ok) await fetchWidgets();
  const res = { at: Date.now(), fetchError: wgFetch?.ok ? '' : wgFetch?.error || '', results: [] };
  for (const r of roots) res.results.push(...(await WG.copyToSender(settings.widgetDir, r, settings.widgetOff || [])).map(x => ({ ...x, root: r })));
  wgCopy = res;
  return res;
}
async function widgetInfo() {
  return { repo: settings.widgetRepo, branch: settings.widgetBranch, dir: settings.widgetDir, auto: settings.widgetAuto !== false, off: settings.widgetOff || [],
    widgets: await WG.listWidgets(path.join(settings.widgetDir, 'scripts')), fetch: wgFetch, copy: wgCopy, senders: watcher.ethosRoots || [] };
}
ipcMain.handle('widgets:info', () => widgetInfo());
ipcMain.handle('widgets:fetch', async () => { await fetchWidgets(); return widgetInfo(); });
ipcMain.handle('widgets:copy', async () => {
  const roots = watcher.ethosRoots || [];
  if (!roots.length) throw new Error('Kein Ethos-Sender angeschlossen.');
  for (let i = 0; watcher.busy && i < 600; i++) await new Promise(r => setTimeout(r, 100));   // laufenden Sync abwarten
  if (watcher.busy) throw new Error('Der Sync läuft noch.');
  const r = await copyWidgets(roots);
  watcher.set({ ...watcher.status, widgets: r });
  return r;
});

// ---------- SkyNavigator: Aufgaben auf den Sender, Flüge (IGC) ins Archiv ----------
async function skynavSync(roots) {
  const out = [];
  for (const r of roots) out.push(await SN.syncSender(r, settings.archiveDir));
  return out;
}
async function afterEthos(roots) {
  const res = settings.widgetAuto === false ? { at: Date.now(), results: [] } : await copyWidgets(roots);
  try { res.skynav = await skynavSync(roots); } catch (e) { res.skynav = { error: e.message }; }
  return res;
}
ipcMain.handle('skynav:get', async () => ({ data: await SN.loadTasks(settings.archiveDir), flights: await SN.listFlights(settings.archiveDir),
  senders: watcher.ethosRoots || [], dir: SN.baseDir(settings.archiveDir) }));
// speichern; toSender: auch gleich auf die angeschlossenen Sender (sonst beim nächsten Anschliessen)
ipcMain.handle('skynav:save', async (_, data, lua, toSender) => {
  await SN.saveTasks(settings.archiveDir, data, lua);
  const written = [];
  if (toSender) for (const r of watcher.ethosRoots || []) written.push(await SN.writeTasksToSender(r, settings.archiveDir));
  return { written };
});
ipcMain.handle('skynav:fetch', async () => {
  const roots = watcher.ethosRoots || [];
  if (!roots.length) throw new Error('Kein Ethos-Sender angeschlossen.');
  return skynavSync(roots);
});
ipcMain.handle('skynav:open', () => { const d = SN.flightDir(settings.archiveDir); fs.mkdirSync(d, { recursive: true }); return shell.openPath(d); });

let lastUpdate = null;
async function checkUpdate() {
  let u = await U.check(app.getVersion(), netJson);
  if (u.error) u = await U.check(app.getVersion());   // zweiter Versuch über Node
  lastUpdate = { ...u, at: Date.now() };
  if (win && !win.isDestroyed()) win.webContents.send('update', lastUpdate);
  return lastUpdate;
}
ipcMain.handle('update:check', () => checkUpdate());
ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('update:open', (_, url) => { if (/^https:\/\/github\.com\/mrskynavi\/(ethos-log-viewer|mm-flight-analyzer)\//.test(url)) shell.openExternal(url); });
ipcMain.handle('file:read', async (_, p) => { if (!allowed(p)) throw new Error('Kein Zugriff'); return S.decodeText(await fs.promises.readFile(p)); });
ipcMain.handle('file:peek', async (_, p, n) => {
  if (!allowed(p)) throw new Error('Kein Zugriff');
  const fh = await fs.promises.open(p, 'r');
  try {
    const { size } = await fh.stat(), len = Math.min(n, size);
    const head = Buffer.alloc(len), tail = Buffer.alloc(len);
    await fh.read(head, 0, len, 0); await fh.read(tail, 0, len, Math.max(0, size - len));
    return { head: S.decodeText(head), tail: S.decodeText(tail), size };
  } finally { await fh.close(); }
});

// ---------- KI-Auswertung: Schlüssel im Schlüsselbund des Systems (safeStorage), Aufruf über das Anthropic-SDK ----------
const KEY_FILE = () => path.join(app.getPath('userData'), 'ai-key.bin');
function readKey() {
  try { const b = fs.readFileSync(KEY_FILE()); return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(b) : null; }
  catch { return null; }
}
// unreadable: Datei da, aber nicht zu entschlüsseln (z. B. Mac nach der Umbenennung: neuer Eintrag im Schlüsselbund)
ipcMain.handle('ai:keyState', () => { const k = readKey(); return k || !fs.existsSync(KEY_FILE()) ? AI.keyState(k) : { set: false, unreadable: true }; });
ipcMain.handle('ai:setKey', (_, key) => {
  if (!key) { try { fs.unlinkSync(KEY_FILE()); } catch {} return AI.keyState(null); }
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Der Schlüsselbund des Systems ist nicht verfügbar.');
  fs.mkdirSync(path.dirname(KEY_FILE()), { recursive: true });
  fs.writeFileSync(KEY_FILE(), safeStorage.encryptString(String(key).trim()));
  return AI.keyState(readKey());
});
ipcMain.handle('ai:test', (_, key) => AI.test(key || readKey()));
ipcMain.handle('ai:create', (_, body) => AI.create(readKey(), body));

// ---------- MCP-Server: nur auf diesem Rechner (127.0.0.1), in den Einstellungen ein- und ausschaltbar ----------
let mcp = null, mcpError = '';
const mcpWanted = () => settings.mcp ? (+settings.mcpPort || M.DEFAULT_PORT) : 0;
const inWindow = js => win && !win.isDestroyed() ? win.webContents.executeJavaScript(js, true) : Promise.reject(new Error('Das Fenster der App ist geschlossen.'));
async function restartMcp() {
  if (mcp) { await mcp.close(); mcp = null; }
  mcpError = '';
  const port = mcpWanted(); if (!port) return;
  const srv = M.createServer({ port, version: app.getVersion(),
    getTools: () => inWindow('window.ETHOS_API ? window.ETHOS_API.tools() : []'),
    callTool: (name, args) => inWindow(`window.ETHOS_API ? window.ETHOS_API.call(${JSON.stringify(name)}, ${JSON.stringify(args)}, 'mcp') : {ok:false,error:'Die App startet noch.'}`)
      .catch(e => ({ ok: false, error: e.message })) });
  try { await srv.listen(); mcp = srv; }
  catch (e) { mcpError = e.code === 'EADDRINUSE' ? `Port ${port} ist schon belegt.` : e.message; }
}
function mcpInfo() {
  const port = +settings.mcpPort || M.DEFAULT_PORT;
  const bridge = app.isPackaged ? path.join(process.resourcesPath, 'mcp-stdio.js') : path.join(__dirname, 'mcp-stdio.js');
  const args = port === M.DEFAULT_PORT ? [bridge] : [bridge, '--port=' + port];
  return { on: !!settings.mcp, running: !!mcp, port, error: mcpError, url: `http://127.0.0.1:${port}/mcp`,
    desktop: { mcpServers: { 'mm-flight-analyzer': { command: process.execPath, args, env: { ELECTRON_RUN_AS_NODE: '1' } } } } };
}
ipcMain.handle('mcp:info', () => mcpInfo());
ipcMain.handle('clipboard:write', (_, t) => { require('electron').clipboard.writeText(String(t)); });

app.whenReady().then(() => {
  loadSettings();
  restartMcp();
  watcher = new S.SyncWatcher(() => settings, { afterEthos: afterEthos });
  fetchWidgets();
  watcher.on('status', s => win && !win.isDestroyed() && win.webContents.send('sync:status', s));
  createWindow();
  watcher.start();
  // alle 6 Stunden nach einer neuen Version schauen, und wenn das Fenster nach mehr als einer Stunde wieder nach vorne kommt
  setInterval(checkUpdate, 6 * 3600 * 1000);
  app.on('browser-window-focus', () => { if (!lastUpdate || Date.now() - lastUpdate.at > 3600 * 1000) checkUpdate(); });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { watcher?.stop(); app.quit(); });
