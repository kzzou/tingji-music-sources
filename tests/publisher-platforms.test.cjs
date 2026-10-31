'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { compileVerified, preliminaryBundle, normalizeVerifiedReports, digest } = require('../lib/publisher.cjs');
const { loadCatalog, mapLimit, validateCandidates, validateAggregate, fixturePlatforms } = require('../scripts/refresh.cjs');
const source = `/*!\n * @name Multiplatform controlled source\n * @author Original author\n */\nlx.on(lx.EVENT_NAMES.request,async()=> 'https://example.test/song.mp3');lx.send(lx.EVENT_NAMES.inited,{sources:{kg:{type:'music',actions:['musicUrl'],qualitys:['128k']},tx:{type:'music',actions:['musicUrl'],qualitys:['128k']}}});`;
const success = platform => ({ platform, init: { status: true }, quality: '128k', resolves: [{ requestKey: 'sample', status: true }], media: { status: 206, bytes: 8192, audioHeader: true }, sample: { name: 'Test', singer: 'Controlled' } });
const candidate = (index, changes = {}) => ({ repository: 'owner/music', commit: 'a'.repeat(40), path: `source-${index}.js`, rawCode: source + `\n// ${index}`, updatedAt: '2026-10-31T00:00:00Z', verification: success('kg'), ...changes });
const temporary = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tingji-platforms-test-'));

test('a source with failed KG and verified TX publishes TX only', () => {
  const tx = success('tx'), kg = { ...success('kg'), media: { status: 403 } };
  const item = candidate(0, { verification: [kg, tx] });
  assert.deepEqual(normalizeVerifiedReports({ reports: [kg, { verification: [tx] }] }).map(row => row.platform), ['tx']);
  const result = compileVerified([item]);
  assert.deepEqual(result.manifest.capabilities, { tx: ['128k'] });
  assert.equal(result.manifest.verification.platform, 'tx');
  assert.equal(result.manifest.upstreams.length, 1);
});

test('final runtime advertises the verified platform matrix rather than a hardcoded KG capability', async () => {
  const result = compileVerified([candidate(1, { verification: [success('tx'), { ...success('kg'), resolveError: 'failed' }] })]);
  const events = [], timers = new Set();
  try {
    vm.runInNewContext(result.script, { lx: { EVENT_NAMES: { request: 'request', inited: 'inited' }, on() {}, send: (event, data) => events.push({ event, data }) }, setTimeout(fn, ms) { const id = setTimeout(fn, ms); timers.add(id); return id; }, clearTimeout: id => { clearTimeout(id); timers.delete(id); } }, { timeout: 1000 });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(JSON.parse(JSON.stringify(events.find(row => row.event === 'inited').data.sources)), { tx: { type: 'music', actions: ['musicUrl'], qualitys: ['128k'] } });
  } finally { for (const timer of timers) clearTimeout(timer); }
});

test('thirty verified candidates fit the 24-provider cap while preserving rare platform coverage', () => {
  const rows = Array.from({ length: 30 }, (_, index) => candidate(index, { verification: success(index === 29 ? 'tx' : 'kg') }));
  const result = compileVerified(rows);
  assert.equal(result.manifest.upstreams.length, 24);
  assert.deepEqual(result.manifest.capabilities, { kg: ['128k'], tx: ['128k'] });
  assert.ok(result.manifest.upstreams.some(row => row.path === 'source-29.js'));
  assert.equal(result.report.rejected.length, 6);
});

test('a large candidate pool respects the exact mobile byte cap without losing a distinct platform', () => {
  const padding = '\n/*' + 'x'.repeat(850000) + '*/';
  const rows = Array.from({ length: 5 }, (_, index) => candidate(index, { rawCode: source + padding + `\n// ${index}`, verification: success(index === 4 ? 'tx' : 'kg') }));
  const result = compileVerified(rows);
  assert.ok(result.manifest.source.bytes <= 6 * 1024 * 1024);
  assert.ok(result.manifest.upstreams.length < 5);
  assert.deepEqual(result.manifest.capabilities, { kg: ['128k'], tx: ['128k'] });
  assert.ok(result.report.rejected.some(row => /6 MiB/.test(row.reason)));
});

test('preliminary wrappers do not require synthetic successful verification records', () => {
  const item = candidate(1, { verification: undefined });
  const script = preliminaryBundle(item, ['kg', 'tx']);
  assert.ok(script.includes(item.rawCode));
  assert.equal(item.verification, undefined);
  assert.equal(compileVerified([item]), null);
});

test('validator reads only hash-named catalog scripts and rejects bytes, traversal and excessive candidates', () => {
  const directory = temporary();
  const bytes = Buffer.from(source), sha256 = digest(bytes);
  const entry = { repository: 'owner/music', commit: 'a'.repeat(40), path: 'latest.js', updatedAt: '2026-10-31T00:00:00Z', file: `scripts/${sha256}.js`, sha256, bytes: bytes.length };
  const write = rows => fs.writeFileSync(path.join(directory, 'catalog.json'), JSON.stringify({ schemaVersion: 1, candidates: rows }));
  fs.mkdirSync(path.join(directory, 'scripts'));
  fs.writeFileSync(path.join(directory, entry.file), bytes);
  try {
    write([entry]); assert.equal(loadCatalog(directory)[0].rawCode, source);
    for (const value of [{ ...entry, file: '../secret' }, { ...entry, bytes: entry.bytes + 1 }, { ...entry, path: '../latest.js' }]) { write([value]); assert.throws(() => loadCatalog(directory)); }
    write(Array.from({ length: 31 }, () => entry)); assert.throws(() => loadCatalog(directory), /catalog/);
    write([entry]); fs.writeFileSync(path.join(directory, entry.file), source + 'tampered'); assert.throws(() => loadCatalog(directory), /mismatch/);
    assert.throws(() => loadCatalog(), /TINGJI_CATALOG_DIR/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('probe orchestration caps simultaneous tasks and preserves task result order', async () => {
  let active = 0, peak = 0;
  const result = await mapLimit([0, 1, 2, 3, 4, 5, 6], 3, async index => { active++; peak = Math.max(peak, active); await new Promise(resolve => setImmediate(resolve)); active--; return index; });
  assert.equal(peak, 3);
  assert.deepEqual(result, [0, 1, 2, 3, 4, 5, 6]);
});

test('candidate validation retains successful TX even when its KG probe fails', async () => {
  const directory = temporary();
  try {
    const rows = [candidate(1, { verification: undefined })];
    const calls = [];
    await validateCandidates(rows, ['kg', 'tx'], directory, '/input/platforms.json', async (file, platform, fixture) => { calls.push({ file, platform, fixture }); return platform === 'tx' ? success(platform) : { platform, runtimeError: 'not available' }; });
    assert.equal(calls.length, 2);
    assert.deepEqual(compileVerified(rows).manifest.capabilities, { tx: ['128k'] });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('aggregate rechecks a reduced platform bundle and keeps all healthy individual providers', async () => {
  const directory = temporary();
  const rows = [candidate(0, { verification: success('kg') }), candidate(1, { verification: success('tx') }), candidate(2, { verification: success('tx') })];
  try {
    const diagnostics = {};
    const result = await validateAggregate(rows, directory, '/input/platforms.json', diagnostics, async (_file, platform) => platform === 'tx' ? success(platform) : { platform, runtimeError: 'aggregate unavailable' });
    assert.deepEqual(result.manifest.capabilities, { tx: ['128k'] });
    assert.equal(result.manifest.upstreams.length, 2);
    assert.equal(diagnostics.aggregate.length, 2);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('fixture platform selection excludes absent and wrongly mapped platform IDs', () => {
  assert.deepEqual(fixturePlatforms({ kg: { modern: { source: 'kg', meta: { songId: 1 } }, legacy: {} }, tx: [{ modern: { source: 'tx', meta: { songId: 'mid' } }, legacy: {} }], wy: { modern: { source: 'kg', meta: { songId: 2 } }, legacy: {} } }), ['kg', 'tx']);
});

test('exhausted overall validation budget stops scheduling more provider executions', async () => {
  const directory = temporary();
  let calls = 0;
  try {
    const rows = [candidate(0, { verification: undefined })];
    await validateCandidates(rows, ['kg', 'tx'], directory, '/input/platforms.json', async platform => { calls++; return success(platform); }, 0);
    assert.equal(calls, 0);
    assert.equal(rows[0].verification.length, 2);
    assert.ok(rows[0].verification.every(row => row.runtimeError.includes('time budget')));
    assert.equal(compileVerified(rows), null);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('generated runtime routes a requested KG song before earlier generic fallbacks while TX keeps its own order', async () => {
  const makeSource = label => `/*!\n * @name ${label}\n */\nlx.on(lx.EVENT_NAMES.request,async({source})=>{globalThis.__hits.push('${label}:'+source);return 'https://example.test/${label}-'+source+'.mp3'});lx.send(lx.EVENT_NAMES.inited,{sources:{kg:{type:'music',actions:['musicUrl'],qualitys:['128k']},tx:{type:'music',actions:['musicUrl'],qualitys:['128k']}}});`;
  const proof = (platform, index, requested = false) => ({ ...success(platform), sample: { name: requested ? 'Requested song' : 'Generic sample', songId: requested ? 'target' : 'generic', index, requested } });
  const rows = [
    candidate(0, { rawCode: makeSource('old-first'), verification: [proof('kg', 1), proof('tx', 0)] }),
    candidate(1, { rawCode: makeSource('old-second'), verification: [proof('kg', 1), proof('tx', 1)] }),
    candidate(2, { rawCode: makeSource('new-target'), verification: [proof('kg', 0, true), proof('tx', 1)] }),
  ];
  const result = compileVerified(rows);
  const hits = [], timers = new Set();
  let handler;
  const host = {
    EVENT_NAMES: { request: 'request', inited: 'inited' },
    on(_event, callback) { handler = callback; },
    send() {},
    request(_url, _options, callback) { queueMicrotask(() => callback(null, { statusCode: 200, headers: { 'content-type': 'audio/mpeg' } })); return () => {}; },
  };
  try {
    vm.runInNewContext(result.script, { lx: host, __hits: hits, setTimeout(fn, ms) { const id = setTimeout(fn, ms); timers.add(id); return id; }, clearTimeout: id => { clearTimeout(id); timers.delete(id); } }, { timeout: 1000 });
    await new Promise(resolve => setImmediate(resolve));
    const request = platform => handler({ source: platform, action: 'musicUrl', info: { type: '128k', musicInfo: { id: 'target', meta: { songId: 'target' } } } });
    assert.equal(await request('kg'), 'https://example.test/new-target-kg.mp3');
    assert.equal(await request('tx'), 'https://example.test/old-first-tx.mp3');
    assert.deepEqual(hits, ['new-target:kg', 'old-first:tx']);
  } finally { for (const timer of timers) clearTimeout(timer); }
});

test('selection reserves a requested-song provider before the count and byte budgets fill with generic providers', () => {
  const rows = Array.from({ length: 30 }, (_, index) => candidate(index));
  rows[29] = candidate(29, { rawCode: source + '\n/*' + 'x'.repeat(850000) + '*/', verification: { ...success('kg'), sample: { requested: true, index: 0, songId: 'user-target', name: 'Requested song' } } });
  const result = compileVerified(rows);
  assert.ok(result.manifest.upstreams.some(row => row.path === 'source-29.js'));
  assert.ok(result.manifest.source.bytes <= 6 * 1024 * 1024);
  assert.ok(result.manifest.upstreams.length <= 24);
  assert.ok(result.manifest.verification.samples.some(row => row.requested === true && row.songId === 'user-target'));
});
