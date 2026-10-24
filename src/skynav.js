// SkyNavigator (Ethos-Widget für GPS Triangle): Aufgaben auf den Sender, Flüge (IGC) ins Archiv.
// Die Aufgaben liegen im Archiv unter SkyNavigator/aufgaben.json (für die App) und aufgaben.lua (für das Widget,
// von der Oberfläche erzeugt). Beim Anschliessen geht aufgaben.lua nach scripts/skynav/ auf den Sender, und die
// Flüge aus scripts/skynav/fluege/ kommen nach SkyNavigator/Fluege/.
// Reines Node, ohne Electron, damit es sich ohne Oberfläche testen lässt.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const SUB = 'SkyNavigator';
const SENDER_DIR = ['scripts', 'skynav'];
const IGC = /\.igc$/i;

const baseDir = archive => path.join(archive, SUB);
const flightDir = archive => path.join(archive, SUB, 'Fluege');

async function writeAtomic(dest, data) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const tmp = dest + '.part';
  try { await fsp.writeFile(tmp, data); }
  catch (e) { await fsp.unlink(tmp).catch(() => {}); throw e; }
  await fsp.rename(tmp, dest);
}

const EMPTY = () => ({ version: 1, active: '', pilot: '', pilotId: '', tasks: [] });

async function loadTasks(archive) {
  try {
    const d = JSON.parse(await fsp.readFile(path.join(baseDir(archive), 'aufgaben.json'), 'utf8'));
    return { ...EMPTY(), ...d, tasks: Array.isArray(d.tasks) ? d.tasks : [] };
  } catch { return EMPTY(); }
}

function checkLua(lua) {
  const s = String(lua || '');
  if (!s.startsWith('--') || !/\breturn\s*\{/.test(s) || s.length > 500000) throw new Error('Ungültige Aufgabendatei');
  return s;
}

// Aufgaben speichern: JSON für die App, Lua für das Widget
async function saveTasks(archive, data, lua) {
  const s = checkLua(lua);
  if (!data || !Array.isArray(data.tasks)) throw new Error('Ungültige Aufgaben');
  await writeAtomic(path.join(baseDir(archive), 'aufgaben.json'), JSON.stringify(data, null, 2));
  await writeAtomic(path.join(baseDir(archive), 'aufgaben.lua'), s);
}

// aufgaben.lua aus dem Archiv auf einen Sender (root = Ordner über logs)
async function writeTasksToSender(root, archive) {
  let lua;
  try { lua = await fsp.readFile(path.join(baseDir(archive), 'aufgaben.lua'), 'utf8'); } catch { return null; }
  const dest = path.join(root, ...SENDER_DIR, 'aufgaben.lua');
  await writeAtomic(dest, checkLua(lua));
  await fsp.mkdir(path.join(root, ...SENDER_DIR, 'fluege'), { recursive: true });
  return dest;
}

// Flüge vom Sender ins Archiv; gleicher Name und gleiche Grösse = schon da. Die Dateien am Sender bleiben.
async function copyFlights(root, archive) {
  const out = { copied: [], same: 0, errors: [] };
  const dst = flightDir(archive);
  for (const sub of [['fluege'], []]) {
    const src = path.join(root, ...SENDER_DIR, ...sub);
    let ents = [];
    try { ents = await fsp.readdir(src, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (!e.isFile() || !IGC.test(e.name) || e.name.startsWith('.')) continue;
      const from = path.join(src, e.name), to = path.join(dst, e.name);
      try {
        const st = await fsp.stat(from);
        if (!st.size) continue;   // Datei, die das Widget gerade erst angelegt hat
        try { if ((await fsp.stat(to)).size === st.size) { out.same++; continue; } } catch {}
        await writeAtomic(to, await fsp.readFile(from));
        out.copied.push(e.name);
      } catch (err) { out.errors.push(e.name + ': ' + err.message); }
    }
  }
  return out;
}

// Beim Anschliessen: Aufgaben hin, Flüge zurück
async function syncSender(root, archive) {
  const r = { root, tasks: null, flights: null };
  try { r.tasks = await writeTasksToSender(root, archive); } catch (e) { r.tasksError = e.message; if (e.code === 'EPERM' || e.code === 'EACCES') throw e; }
  r.flights = await copyFlights(root, archive);
  return r;
}

async function listFlights(archive) {
  const dir = flightDir(archive);
  let ents = [];
  try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of ents) {
    if (!e.isFile() || !IGC.test(e.name)) continue;
    const p = path.join(dir, e.name);
    try { const st = await fsp.stat(p); out.push({ name: e.name, path: p, size: st.size, mtime: st.mtimeMs }); } catch {}
  }
  return out.sort((a, b) => b.name.localeCompare(a.name));
}

module.exports = { SUB, baseDir, flightDir, loadTasks, saveTasks, writeTasksToSender, copyFlights, syncSender, listFlights };
