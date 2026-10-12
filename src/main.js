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

// Daten aus dem Ordner der früheren App „Ethos Log Viewer“ übernehmen, bevor irgendetwas den neuen Ordner benutzt
const MIGRATED = MG.migrate(path.join(app.getPath('appData'), MG.OLD_NAME), app.getPath('userData'));

const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json');
const DEFAULTS = () => ({ senderPath: 'Radio/logs', archiveDir: S.defaultArchive(), autoSync: true, archiveManual: false, mcp: false, mcpPort: M.DEFAULT_PORT });
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
  if (settings.simScripts && fs.existsSync(settings.simScripts)) return { dir: settings.simScripts, source: 'ordner' };
  for (const r of watcher.ethosRoots || []) { const d = path.join(r, 'scripts'); if (fs.existsSync(d)) return { dir: d, source: 'sender' }; }
  return null;
}
ipcMain.handle('scripts:read', async (_, opts) => {
  const t = await simScriptsDir(opts || {});
  if (!t) { simDir = null; return { files: {}, error: opts?.sender ? 'Kein Ethos-Sender mit scripts-Ordner angeschlossen.' : null }; }
  simDir = t.dir;
  return { ...t, files: await S.readScripts(t.dir) };
});
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
  watcher = new S.SyncWatcher(() => settings);
  watcher.on('status', s => win && !win.isDestroyed() && win.webContents.send('sync:status', s));
  createWindow();
  watcher.start();
  // alle 6 Stunden nach einer neuen Version schauen, und wenn das Fenster nach mehr als einer Stunde wieder nach vorne kommt
  setInterval(checkUpdate, 6 * 3600 * 1000);
  app.on('browser-window-focus', () => { if (!lastUpdate || Date.now() - lastUpdate.at > 3600 * 1000) checkUpdate(); });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { watcher?.stop(); app.quit(); });
