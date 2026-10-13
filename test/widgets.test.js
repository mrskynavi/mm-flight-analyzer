const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const W = require('../src/widgets');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wgt-'));
const put = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };

test('header liest Name und Version aus den Kommentarzeilen', () => {
  assert.deepStrictEqual(W.header('-- @widget  Sollfahrt\n-- @version 1.4\n-- Text\nlocal x = 1'), { widget: 'Sollfahrt', version: '1.4' });
  assert.deepStrictEqual(W.header('-- ohne Kopfzeile'), {});
});

test('blobSha entspricht git hash-object', () => {
  assert.strictEqual(W.blobSha(Buffer.from('hello\n')), 'ce013625030ba8dba906f756967f9e9ca394464a');
});

test('fetchRepo lädt scripts/, überspringt Unverändertes und polaren.lua, entfernt Gelöschtes', async () => {
  const dir = tmp();
  const files = { 'scripts/sollfahrt/main.lua': '-- @widget Sollfahrt\n-- @version 1.4\n', 'scripts/wind/main.lua': '-- @version 2.2\n',
    'scripts/maccready/polaren.lua': '-- nie', 'README.md': '# x' };
  const tree = () => ({ tree: Object.entries(files).map(([p, c]) => ({ path: p, type: 'blob', sha: W.blobSha(Buffer.from(c)) })) });
  let gets = 0;
  const getBuf = async url => { gets++; const p = decodeURIComponent(url.split('/main/')[1]); return Buffer.from(files[p]); };
  const r = await W.fetchRepo({ repo: 'a/b', branch: 'main', dir, getJson: async () => tree(), getBuf });
  assert.strictEqual(r.loaded, 2); assert.strictEqual(gets, 2);
  assert.ok(!fs.existsSync(path.join(dir, 'scripts', 'maccready', 'polaren.lua')));
  assert.deepStrictEqual(r.widgets.map(w => [w.name, w.title, w.version]), [['sollfahrt', 'Sollfahrt', '1.4'], ['wind', 'wind', '2.2']]);
  // eigenes lokales Widget bleibt, im Repo gelöschtes verschwindet
  put(path.join(dir, 'scripts', 'eigen', 'main.lua'), '-- lokal');
  delete files['scripts/wind/main.lua'];
  const r2 = await W.fetchRepo({ repo: 'a/b', branch: 'main', dir, getJson: async () => tree(), getBuf });
  assert.strictEqual(r2.loaded, 0); assert.strictEqual(r2.same, 1); assert.strictEqual(r2.removed, 1);
  assert.deepStrictEqual(r2.widgets.map(w => w.name), ['eigen', 'sollfahrt']);
  await assert.rejects(W.fetchRepo({ repo: 'kein repo', branch: 'main', dir, getJson: async () => ({}), getBuf }));
});

test('copyToSender kopiert immer, überschreibt ohne Sicherung, lässt Daten und ausgeschaltete Widgets', async () => {
  const dir = tmp(), radio = tmp();
  put(path.join(dir, 'scripts', 'sollfahrt', 'main.lua'), '-- @version 1.4\nneu');
  put(path.join(dir, 'scripts', 'polarflug', 'main.lua'), '-- @version 1.0\n');
  put(path.join(dir, 'scripts', 'test', 'main.lua'), '-- @version 0.9\n');
  put(path.join(radio, 'scripts', 'sollfahrt', 'main.lua'), '-- @version 1.4\nalt');
  put(path.join(radio, 'scripts', 'polarflug', 'punkte_SB-10.txt'), 'daten');
  const r = await W.copyToSender(dir, radio, ['test']);
  assert.deepStrictEqual(r.map(x => [x.name, x.before, x.state]), [['polarflug', null, 'neu'], ['sollfahrt', '1.4', 'überschrieben']]);
  assert.strictEqual(fs.readFileSync(path.join(radio, 'scripts', 'sollfahrt', 'main.lua'), 'utf8'), '-- @version 1.4\nneu');
  assert.deepStrictEqual(fs.readdirSync(path.join(radio, 'scripts', 'sollfahrt')), ['main.lua']);
  assert.strictEqual(fs.readFileSync(path.join(radio, 'scripts', 'polarflug', 'punkte_SB-10.txt'), 'utf8'), 'daten');
  assert.ok(!fs.existsSync(path.join(radio, 'scripts', 'test')));
});
