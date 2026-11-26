// MM-Hangar: ein Ordner für alle Apps (Flight Analyzer, SkyNavigator-App, später weitere).
// Entscheid Christoph 2026-11-26: Hangar in Google Drive „Meine Ablage/MM-Hangar“, beide Apps schreiben dorthin,
// die Sperrdatei .mm-radio-sync.lock verhindert gleichzeitigen Sender-Sync. Das alte Archiv wird einmal kopiert
// (nie gelöscht oder verändert). Aufbau wie @mm-suite/hangar-sync:
//   modelle/<Modell-ID>/fluege/<Log>     Ethos-CSV und Jeti-Logs
//   skynav/aufgaben.json, aufgaben.lua    SkyNavigator-Aufgaben
//   skynav/fluege/<IGC>                   SkyNavigator-Flüge, gelöschte in skynav/fluege/Gelöscht
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

const LOCK = '.mm-radio-sync.lock';
const LOCK_TTL = 5 * 60 * 1000;
const DELETED = 'Gelöscht';

// Modell-ID: eine Regel für alle Apps (Bindestrich). „ASW_17“, „ASW 17“ und „ASW-17“ sind dasselbe Modell.
function modelId(name) {
  const s = String(name || 'modell').trim()
    .replace(/ä/gi, 'ae').replace(/ö/gi, 'oe').replace(/ü/gi, 'ue').replace(/ß/g, 'ss')
    .replace(/[^A-Za-z0-9.-]+/g, '-').replace(/-{2,}/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  return s || 'modell';
}

// Ein Ordner gilt als Hangar, wenn er hangar.json oder modelle/ enthält
function isHangar(dir) {
  try { return fs.existsSync(path.join(dir, 'hangar.json')) || fs.statSync(path.join(dir, 'modelle')).isDirectory(); }
  catch { return false; }
}

// Google Drive für Desktop: „Meine Ablage/MM-Hangar“; vorhandener Hangar zuerst. Sonst ~/MM-Hangar.
function defaultHangar(home = os.homedir(), platform = process.platform) {
  const roots = [];
  const my = base => { for (const n of ['Meine Ablage', 'My Drive']) roots.push(path.join(base, n)); };
  if (platform === 'darwin') {
    const cs = path.join(home, 'Library', 'CloudStorage');
    let names = [];
    try { names = fs.readdirSync(cs).filter(n => /^GoogleDrive-/i.test(n)).sort(); } catch {}
    for (const n of names) my(path.join(cs, n));
  } else if (platform === 'win32') {
    for (const L of 'GDEFHIJKLMNOPQRSTUVWXYZ') my(`${L}:\\`);
  }
  my(path.join(home, 'Google Drive'));
  const ok = roots.filter(r => { try { return fs.statSync(r).isDirectory(); } catch { return false; } });
  const existing = ok.find(r => isHangar(path.join(r, 'MM-Hangar')));
  if (existing) return path.join(existing, 'MM-Hangar');
  return ok.length ? path.join(ok[0], 'MM-Hangar') : path.join(home, 'MM-Hangar');
}

// Sperrdatei (gleiches Format wie hangar-sync): { pid, app, createdAt }; älter als 5 min gilt als verwaist
async function acquireLock(dir, appName = 'MM Flight Analyzer') {
  const file = path.join(dir, LOCK);
  await fsp.mkdir(dir, { recursive: true });
  const payload = JSON.stringify({ pid: process.pid, app: appName, createdAt: Date.now() });
  const tryOpen = async () => { const fh = await fsp.open(file, 'wx'); await fh.writeFile(payload, 'utf8'); await fh.close(); };
  try { await tryOpen(); return { acquired: true }; }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    try {
      const info = JSON.parse(await fsp.readFile(file, 'utf8'));
      if (Date.now() - (info.createdAt || 0) > LOCK_TTL) { await fsp.rm(file, { force: true }); await tryOpen(); return { acquired: true }; }
      return { acquired: false, lockedBy: `${info.app || 'andere App'} (PID ${info.pid || '?'})` };
    } catch { return { acquired: false, lockedBy: 'andere App' }; }
  }
}
async function releaseLock(dir) { await fsp.rm(path.join(dir, LOCK), { force: true }).catch(() => {}); }

async function copyIfNew(from, to) {
  const st = await fsp.stat(from);
  try { if ((await fsp.stat(to)).size === st.size) return false; } catch {}
  await fsp.mkdir(path.dirname(to), { recursive: true });
  await fsp.copyFile(from, to + '.part');
  await fsp.rename(to + '.part', to);
  try { await fsp.utimes(to, st.atime, st.mtime); } catch {}
  return true;
}

// Altes Archiv (ein Ordner pro Modell, SkyNavigator/) einmal in den Hangar kopieren. Quelle bleibt unverändert.
// modelOf: Modellname aus dem Dateinamen (aus sync.js), listArchive: alle Logs im alten Archiv
async function migrateArchive(oldDir, hangarDir, { modelOf, listArchive }) {
  const rep = { logs: 0, same: 0, tasks: 0, flights: 0, errors: [] };
  if (!oldDir || path.resolve(oldDir) === path.resolve(hangarDir)) return rep;
  for (const f of await listArchive(oldDir)) {
    try {
      // Jeti-Logs liegen im alten Archiv im Ordner „Jeti“; Modell aus dem Dateinamen, sonst aus dem Ordner
      let m = modelOf(f.name);
      if (m === 'Ohne Modell') m = path.basename(path.dirname(f.path));
      const to = path.join(hangarDir, 'modelle', modelId(m), 'fluege', f.name);
      if (await copyIfNew(f.path, to)) rep.logs++; else rep.same++;
    } catch (e) { rep.errors.push(`${f.name}: ${e.message}`); }
  }
  const oldSn = path.join(oldDir, 'SkyNavigator');
  try {
    const old = JSON.parse(await fsp.readFile(path.join(oldSn, 'aufgaben.json'), 'utf8'));
    const dest = path.join(hangarDir, 'skynav', 'aufgaben.json');
    let cur = null;
    try { cur = JSON.parse(await fsp.readFile(dest, 'utf8')); } catch {}
    if (!cur || !Array.isArray(cur.tasks)) cur = { ...old, tasks: [] };
    const have = new Set(cur.tasks.map(t => t.id));
    for (const t of old.tasks || []) if (t && t.id && !have.has(t.id)) { cur.tasks.push(t); have.add(t.id); rep.tasks++; }
    if (!cur.active && old.active) cur.active = old.active;
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.writeFile(dest, JSON.stringify(cur, null, 2));
    const lua = path.join(hangarDir, 'skynav', 'aufgaben.lua');
    if (!fs.existsSync(lua) && fs.existsSync(path.join(oldSn, 'aufgaben.lua'))) await fsp.copyFile(path.join(oldSn, 'aufgaben.lua'), lua);
  } catch {}
  let igc = [];
  try { igc = (await fsp.readdir(path.join(oldSn, 'Fluege'))).filter(n => /\.igc$/i.test(n) && !n.startsWith('.')); } catch {}
  for (const n of igc) {
    try { if (await copyIfNew(path.join(oldSn, 'Fluege', n), path.join(hangarDir, 'skynav', 'fluege', n))) rep.flights++; }
    catch (e) { rep.errors.push(`${n}: ${e.message}`); }
  }
  await ensureIndex(hangarDir);
  return rep;
}

// hangar.json anlegen, falls es fehlt (gleiches Schema wie hangar-sync)
async function ensureIndex(hangarDir) {
  const f = path.join(hangarDir, 'hangar.json');
  if (fs.existsSync(f)) return;
  const now = new Date().toISOString();
  await fsp.mkdir(hangarDir, { recursive: true });
  await fsp.writeFile(f, JSON.stringify({ format: 'mm-hangar', version: 1, createdAt: now, updatedAt: now, models: [], experienceFactors: {},
    sync: { widgetRepo: 'mrskynavi/mm-ethos-widgets', widgetBranch: 'main', disabledWidgets: [] } }, null, 2) + '\n');
}

module.exports = { LOCK, DELETED, modelId, isHangar, defaultHangar, acquireLock, releaseLock, migrateArchive, ensureIndex };
