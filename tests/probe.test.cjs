'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const { selectFixture, kind, audioSizeCheck } = require('../lib/probe.cjs');
const { audioVerified } = require('../lib/publisher.cjs');

test('fixture lookup keeps platform metadata separate and supports direct and old catalog formats', () => {
  const tx = { modern: { source: 'tx', meta: { songId: 'verified-mid' } }, legacy: { source: 'tx' } };
  assert.equal(selectFixture({ tx }, 'tx'), tx);
  assert.equal(selectFixture({ tx: [tx] }, 'tx'), tx);
  assert.equal(selectFixture({ kg: tx }, 'kg'), null);
  assert.equal(selectFixture({ tx: { modern: { source: 'tx', meta: {} } } }, 'tx'), null);
  assert.equal(selectFixture({ fixtures: [{ source: 'tx', musicInfo: tx.modern, legacy: tx.legacy }] }, 'tx').modern, tx.modern);
});

test('audio signature sniffing rejects a 200 response containing JSON or HTML', () => {
  assert.equal(kind(Buffer.from('ID3' + 'x'.repeat(64))), 'MP3/AAC');
  assert.equal(kind(Buffer.from('{"error":"no audio"}')), 'JSON');
  assert.equal(kind(Buffer.from('<html>denied</html>')), 'HTML/XML');
});

test('song size checks use reliable full lengths and the mobile duration threshold', () => {
  const check = (statusCode, headers, interval = '03:00') => audioSizeCheck(interval, { statusCode, headers });
  const ranged = { 'content-length': '8192', 'content-range': 'bytes 0-8191/4000000' };
  assert.equal(check(206, ranged).tooSmall, false);
  assert.equal(check(206, { ...ranged, 'content-range': 'bytes 0-8191/33000' }).tooSmall, true);
  assert.equal(check(200, { 'content-length': '811008' }).tooSmall, false);
  assert.equal(check(200, { 'content-length': '811007' }).tooSmall, true);
  assert.equal(check(200, { 'content-length': '20000' }, '01:29').tooSmall, undefined);
  assert.equal(check(200, { 'content-length': '20000' }, '01:30').tooSmall, true);
  assert.equal(check(200, { 'content-length': '20000' }, '').tooSmall, undefined);
  for (const headers of [
    { 'content-length': '8192' }, { ...ranged, 'content-range': 'bytes 0-8191/*' },
    { ...ranged, 'content-range': 'bytes 0-8191/13' }, { ...ranged, 'content-length': '10' },
    { ...ranged, 'content-encoding': 'gzip' },
  ]) assert.deepEqual(check(206, headers), {});
  assert.deepEqual(check(200, { 'content-length': '8192', 'content-encoding': 'br' }), {});
});

test('actual Android preload probes TX independently of a failed KG media response', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tingji-probe-test-'));
  const file = path.join(directory, 'controlled.js');
  const fixtureName = path.join(directory, 'fixtures.json');
  fs.writeFileSync(file, `/*!\n * @name Controlled test provider\n */\nlx.on(lx.EVENT_NAMES.request, async ({source}) => 'https://example.test/' + source + '.mp3');\nlx.send(lx.EVENT_NAMES.inited,{sources:{kg:{type:'music',actions:['musicUrl'],qualitys:['128k']},tx:{type:'music',actions:['musicUrl'],qualitys:['128k']}}});`);
  fs.writeFileSync(fixtureName, JSON.stringify(Object.fromEntries(['kg', 'tx'].map(platform => [platform, { modern: { id: `controlled_${platform}`, source: platform, name: 'Controlled test song', singer: 'Test', meta: { songId: 'controlled-id' } }, legacy: { source: platform, songmid: 'controlled-id' } }]))));
  const probeFile = require.resolve('../lib/probe.cjs');
  const loaded = new Module(probeFile, module);
  const nativeRequire = Module.createRequire(probeFile);
  loaded.require = name => name === './network.cjs' ? {
    safeURL: value => new URL(value),
    requestPrefix: async value => ({ statusCode: 206, statusMessage: 'Partial Content', headers: { 'content-type': 'audio/mpeg' }, bytes: Buffer.from(new URL(value).pathname === '/tx.mp3' ? 'ID3' + 'x'.repeat(100) : '{"error":"no audio"}' + ' '.repeat(64)) }),
  } : nativeRequire(name);
  loaded._compile(fs.readFileSync(probeFile, 'utf8'), probeFile);
  const oldCI = process.env.CI, oldActions = process.env.GITHUB_ACTIONS;
  process.env.CI = 'true'; process.env.GITHUB_ACTIONS = 'true';
  try {
    const tx = await loaded.exports.runProbe({ file, platform: 'tx', fixtureName });
    const kg = await loaded.exports.runProbe({ file, platform: 'kg', fixtureName });
    assert.equal(audioVerified(tx), true, JSON.stringify(tx));
    assert.equal(audioVerified(kg), false);
    assert.equal(tx.platform, 'tx');
    assert.equal(tx.sample.name, 'Controlled test song');
    assert.equal(tx.quality, '128k');
    assert.equal(tx.media.kind, 'MP3/AAC');
    assert.equal(kg.media.kind, 'JSON');
    assert.equal(JSON.stringify(tx.resolves).includes('https://example.test'), false);
  } finally {
    if (oldCI === undefined) delete process.env.CI; else process.env.CI = oldCI;
    if (oldActions === undefined) delete process.env.GITHUB_ACTIONS; else process.env.GITHUB_ACTIONS = oldActions;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('bounded probes try the fallback after JSON or an undersized MP3 response', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tingji-probe-fallback-test-'));
  const file = path.join(directory, 'controlled.js');
  const fixtureName = path.join(directory, 'fixtures.json');
  fs.writeFileSync(file, `/*!
 * @name Controlled fallback test
 */
const ping = () => new Promise((resolve, reject) => lx.request('https://example.test/ping', {}, error => error ? reject(error) : resolve()));
lx.on(lx.EVENT_NAMES.request, async ({info}) => {
  const id = info.musicInfo.meta.songId;
  if (id === 'first') {
    for (let i = 0; i < 80; i++) {
      try { await ping(); } catch { break; }
    }
  } else await ping();
  return 'https://example.test/' + id + '.mp3';
});
ping().then(() => lx.send(lx.EVENT_NAMES.inited,{sources:{kg:{type:'music',actions:['musicUrl'],qualitys:['128k']}}}));`);
  fs.writeFileSync(fixtureName, JSON.stringify({ kg: ['first', 'second'].map(id => ({ requested: id === 'second', modern: { id, source: 'kg', name: id, singer: 'Controlled', interval: '04:00', meta: { songId: id } }, legacy: { source: 'kg', songmid: id } })) }));
  const probeFile = require.resolve('../lib/probe.cjs');
  const loaded = new Module(probeFile, module), nativeRequire = Module.createRequire(probeFile);
  let preview = false;
  loaded.require = name => name === './network.cjs' ? {
    safeURL: value => new URL(value),
    requestPrefix: async value => {
      const short = preview && new URL(value).pathname === '/first.mp3';
      return {
        statusCode: 206, statusMessage: 'Partial Content',
        headers: short ? { 'content-range': 'bytes 0-102/10000', 'content-length': '103' } : {},
        bytes: Buffer.from(short || new URL(value).pathname === '/second.mp3' ? 'ID3' + 'x'.repeat(100) : '{"error":"first unavailable"}' + ' '.repeat(64)),
      };
    },
  } : nativeRequire(name);
  loaded._compile(fs.readFileSync(probeFile, 'utf8'), probeFile);
  const oldCI = process.env.CI, oldActions = process.env.GITHUB_ACTIONS;
  process.env.CI = 'true'; process.env.GITHUB_ACTIONS = 'true';
  try {
    for (const [profile, limit] of [['candidate', 24], ['aggregate', 72]]) {
      preview = profile === 'aggregate';
      const report = await loaded.exports.runProbe({ file, platform: 'kg', fixtureName, profile });
      assert.equal(audioVerified(report), true, JSON.stringify(report));
      assert.equal(report.attempts.length, 2);
      assert.deepEqual(report.attempts.map(row => row.requestKey), ['sample-0', 'sample-1']);
      assert.equal(report.attempts[0].media.kind, preview ? 'MP3/AAC' : 'JSON');
      if (preview) {
        assert.equal(report.attempts[0].media.tooSmall, true);
        assert.equal(audioVerified({ ...report, media: report.attempts[0].media }), false);
      }
      assert.equal(report.attempts[1].media.kind, 'MP3/AAC');
      assert.equal(report.sample.name, 'second');
      assert.equal(report.sample.requested, true);
      assert.equal(report.resolves[0].requestKey, 'sample');
      assert.equal(report.resolveError, undefined);
      assert.deepEqual(report.bootRequests, { limit: 24, accepted: 1, rejected: 0 });
      assert.deepEqual(report.attempts.map(attempt => attempt.requestBudget), [{ limit, accepted: limit, rejected: 1 }, { limit, accepted: 1, rejected: 0 }]);
      assert.ok(report.attempts.every(attempt => Number.isFinite(attempt.elapsedMs) && attempt.elapsedMs >= 0));
      assert.equal(report.requests.length, limit + 2);
      assert.equal(JSON.stringify(report).includes('https://example.test/'), false);
    }
  } finally {
    if (oldCI === undefined) delete process.env.CI; else process.env.CI = oldCI;
    if (oldActions === undefined) delete process.env.GITHUB_ACTIONS; else process.env.GITHUB_ACTIONS = oldActions;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
