'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { digest, selectNewestUnique, audioVerified, sanitizeDiagnostics, compileVerified, writeOutput } = require('../lib/publisher.cjs');
const { sourcePaths } = require('../lib/discovery.cjs');
const { publicAddress, safeURL } = require('../lib/network.cjs');
const source = `/*!\n * @name Author source\n * @author Original author\n * @version 2\n */\nlx.on(lx.EVENT_NAMES.request, async () => 'https://example.com/song.mp3');\nlx.send(lx.EVENT_NAMES.inited, {sources:{kg:{type:'music',actions:['musicUrl'],qualitys:['128k','320k']},tx:{type:'music',actions:['musicUrl'],qualitys:['128k']}}});`;
const verification = () => ({ init: { status: true }, quality: '128k', resolves: [{ requestKey: 'sample', status: true }], media: { status: 206, bytes: 8192, audioHeader: true } });
const candidate = (changes = {}) => ({ repository: 'author/music', path: 'latest.js', commit: 'a'.repeat(40), rawCode: source, updatedAt: '2026-10-30T00:00:00Z', verification: verification(), ...changes });

test('deduplicates content across repositories before limiting to ten by file update date', () => {
  const values = Array.from({ length: 13 }, (_, i) => candidate({ path: `${i}/latest.js`, rawCode: `${source}\n// ${i}`, updatedAt: new Date(2026, 9, i + 1).toISOString() }));
  values.push({ ...values[12], repository: 'fork/music', updatedAt: '2026-10-30T00:00:00Z' });
  const selected = selectNewestUnique(values);
  assert.equal(selected.length, 10);
  assert.equal(selected[0].repository, 'fork/music');
  assert.equal(new Set(selected.map(item => item.sha256)).size, 10);
  assert.ok(Date.parse(selected[1].updatedAt) > Date.parse(selected[9].updatedAt));
});

test('requires successful resolver AND HTTP audio prefix, never init alone', () => {
  assert.equal(audioVerified(verification()), true);
  for (const mutation of [
    row => { row.init.status = false; }, row => { row.resolves[0].status = false; },
    row => { row.media.status = 403; }, row => { row.media.bytes = 0; },
    row => { row.media.audioHeader = false; }, row => { row.runtimeError = 'failed'; },
    row => { row.quality = '320k'; }, row => { row.media.error = 'truncated'; },
  ]) { const row = verification(); mutation(row); assert.equal(audioVerified(row), false); }
});

test('returns no publishable manifest when all new candidates fail', () => {
  assert.equal(compileVerified([candidate({ verification: {} })]), null);
  assert.equal(compileVerified([candidate({ rawCode: 'invalid code' })]), null);
});

test('manifest hashes exact UTF8 bytes, carries immutable provenance and verified capabilities', () => {
  const result = compileVerified([candidate()], new Date('2026-10-30T18:00:00Z'));
  assert.deepEqual(result.manifest.capabilities, { kg: ['128k'] });
  assert.equal(result.manifest.source.sha256, digest(result.script));
  assert.equal(result.manifest.source.sha1, digest(result.script, 'sha1'));
  assert.equal(result.manifest.source.bytes, Buffer.byteLength(result.script));
  assert.equal(result.manifest.source.path, `sources/${digest(result.script)}.js`);
  assert.equal(result.manifest.upstreams[0].sha256, digest(source));
  assert.equal(result.manifest.upstreams[0].commit, 'a'.repeat(40));
  assert.ok(result.script.includes(source));
  assert.ok(result.script.includes('Original author'));
});

test('generated runtime advertises only verified provider platform/quality despite broader original init', async () => {
  const result = compileVerified([candidate()]);
  const calls = [];
  const timers = new Set();
  const host = {
    EVENT_NAMES: { request: 'request', inited: 'inited' },
    on() {}, request() {}, send(event, data) { calls.push({ event, data }); },
  };
  const context = vm.createContext({ lx: host, setTimeout(fn, time) { const timer = setTimeout(fn, time); timers.add(timer); return timer; }, clearTimeout(timer) { timers.delete(timer); clearTimeout(timer); } });
  try {
    vm.runInContext(result.script, context, { timeout: 1000 });
    await new Promise(resolve => setImmediate(resolve));
    const init = calls.find(call => call.event === 'inited');
    assert.deepEqual(JSON.parse(JSON.stringify(init.data.sources)), { kg: { type: 'music', actions: ['musicUrl'], qualitys: ['128k'] } });
  } finally { for (const timer of timers) clearTimeout(timer); }
});

test('no-pass output removes only pending manifest and preserves immutable source assets', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tingji-publisher-test-'));
  try {
    const result = compileVerified([candidate()]);
    assert.equal(writeOutput(directory, result), true);
    assert.equal(fs.readFileSync(path.join(directory, result.manifest.source.path), 'utf8'), result.script);
    assert.equal(writeOutput(directory, null), false);
    assert.equal(fs.existsSync(path.join(directory, 'manifest.json')), false);
    assert.equal(fs.existsSync(path.join(directory, result.manifest.source.path)), true);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('discovery prefers latest.js and excludes oversized files/symlinks/build directories', () => {
  const file = path => ({ path, type: 'blob', mode: '100644', size: 1024 });
  assert.deepEqual(sourcePaths([file('source/latest.js'), file('source/1.0.js'), file('node_modules/x/latest.js'), { ...file('huge/latest.js'), size: 2e6 }, { ...file('link/latest.js'), mode: '120000' }]).map(item => item.path), ['source/latest.js']);
  assert.deepEqual(sourcePaths([file('source.js'), file('src/util.js')]).map(item => item.path), ['source.js']);
});

test('equal-timestamp candidates prefer previously compatible source families, never over newer files', () => {
  const same = '2026-10-30T00:00:00Z';
  const rows = [candidate({ path: 'a/latest.js', rawCode: source + '//a', updatedAt: same }), candidate({ path: 'xinghai/latest.js', rawCode: source + '//b', updatedAt: same }), candidate({ path: 'new/latest.js', rawCode: source + '//c', updatedAt: '2026-10-31T00:00:00Z' })];
  assert.deepEqual(selectNewestUnique(rows).map(row => row.path), ['new/latest.js', 'xinghai/latest.js', 'a/latest.js']);
});

test('blocks private, metadata, IPv6 mapped-local and credential URLs', () => {
  for (const value of ['127.0.0.1', '169.254.169.254', '192.168.1.1', '172.31.0.1', '0.0.0.0', '198.18.0.1', '::1', '::ffff:127.0.0.1', 'fd00::1', 'fe80::1']) assert.equal(publicAddress(value), false, value);
  assert.equal(publicAddress('8.8.8.8'), true);
  assert.equal(publicAddress('2606:4700:4700::1111'), true);
  for (const value of ['http://127.0.0.1', 'http://[::ffff:127.0.0.1]', 'https://user:password@8.8.8.8', 'file:///etc/passwd', 'http://localhost']) assert.throws(() => safeURL(value), /blocked/);
  assert.equal(safeURL('https://example.com/song.mp3').hostname, 'example.com');
});

test('sanitizes nested diagnostics, provider requests, URLs and credential fields', () => {
  const result = sanitizeDiagnostics({ candidates: [{ verification: { requests: [{ path: '/private-path' }], url: 'https://private.example/file?sign=abcd', nested: { Authorization: 'abc', errorMessage: 'fetch https://example.com/media?signature=123 failed; token=secret123' } } }], aggregate: { requests: [{ path: '/private-path' }] } });
  const text = JSON.stringify(result);
  for (const value of ['private-path', 'private.example', 'signature=123', 'secret123', '"abc"']) assert.equal(text.includes(value), false, value);
  assert.equal(result.candidates[0].verification.nested.Authorization, '[redacted]');
  assert.equal(result.aggregate.requests, undefined);
});
