'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const { selectFixture, kind } = require('../lib/probe.cjs');
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

test('the same initialized provider can pass its second real sample after the first returned JSON', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tingji-probe-fallback-test-'));
  const file = path.join(directory, 'controlled.js');
  const fixtureName = path.join(directory, 'fixtures.json');
  fs.writeFileSync(file, `/*!\n * @name Controlled fallback test\n */\nlx.on(lx.EVENT_NAMES.request, async ({info}) => 'https://example.test/' + info.musicInfo.meta.songId + '.mp3');lx.send(lx.EVENT_NAMES.inited,{sources:{kg:{type:'music',actions:['musicUrl'],qualitys:['128k']}}});`);
  fs.writeFileSync(fixtureName, JSON.stringify({ kg: ['first', 'second'].map(id => ({ requested: id === 'second', modern: { id, source: 'kg', name: id, singer: 'Controlled', meta: { songId: id } }, legacy: { source: 'kg', songmid: id } })) }));
  const probeFile = require.resolve('../lib/probe.cjs');
  const loaded = new Module(probeFile, module), nativeRequire = Module.createRequire(probeFile);
  loaded.require = name => name === './network.cjs' ? {
    safeURL: value => new URL(value),
    requestPrefix: async value => ({ statusCode: 206, statusMessage: 'Partial Content', headers: {}, bytes: Buffer.from(new URL(value).pathname === '/second.mp3' ? 'ID3' + 'x'.repeat(100) : '{"error":"first unavailable"}' + ' '.repeat(64)) }),
  } : nativeRequire(name);
  loaded._compile(fs.readFileSync(probeFile, 'utf8'), probeFile);
  const oldCI = process.env.CI, oldActions = process.env.GITHUB_ACTIONS;
  process.env.CI = 'true'; process.env.GITHUB_ACTIONS = 'true';
  try {
    const report = await loaded.exports.runProbe({ file, platform: 'kg', fixtureName });
    assert.equal(audioVerified(report), true, JSON.stringify(report));
    assert.equal(report.attempts.length, 2);
    assert.deepEqual(report.attempts.map(row => row.requestKey), ['sample-0', 'sample-1']);
    assert.equal(report.attempts[0].media.kind, 'JSON');
    assert.equal(report.attempts[1].media.kind, 'MP3/AAC');
    assert.equal(report.sample.name, 'second');
    assert.equal(report.sample.requested, true);
    assert.equal(report.resolves[0].requestKey, 'sample');
    assert.equal(report.resolveError, undefined);
    assert.equal(JSON.stringify(report).includes('https://example.test/'), false);
  } finally {
    if (oldCI === undefined) delete process.env.CI; else process.env.CI = oldCI;
    if (oldActions === undefined) delete process.env.GITHUB_ACTIONS; else process.env.GITHUB_ACTIONS = oldActions;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
