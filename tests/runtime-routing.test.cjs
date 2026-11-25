'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { generateSourceBundle } = require('../lib/generator.cjs');

const flush = () => new Promise(resolve => setImmediate(resolve));
const media = 'https://audio.invalid/track.mp3';

function harness(rows, { timeoutMs = 8000, headStatus = 200 } = {}) {
  const timers = new Map(), hits = [];
  let time = 0, nextId = 0, handler;
  function later(callback, delay) {
    const id = ++nextId;
    timers.set(id, { at: time + delay, callback });
    return id;
  }
  async function advance(to) {
    await flush();
    for (;;) {
      const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > to) break;
      time = next[1].at;
      timers.delete(next[0]);
      next[1].callback();
      await flush();
    }
    time = to;
  }
  const entry = { type: 'music', actions: ['musicUrl'], qualitys: ['128k', '320k'] };
  const sources = { kg: entry, kw: entry };
  const inputs = rows.map(({ name, body, group }) => ({
    id: name, endpointGroup: group, verifiedCapabilities: { kg: entry.qualitys, kw: entry.qualitys },
    rawCode: '/*!\n * @name ' + name + '\n */\n' +
      'lx.on("request", async input => { const song = input.info.musicInfo.id;' +
      'globalThis.hits.push([' + JSON.stringify(name) + ', song, Date.now()]);' + body + '});' +
      'lx.send("inited", {sources:' + JSON.stringify(sources) + '});',
  }));
  vm.runInNewContext(generateSourceBundle(inputs, { timeoutMs }).script, {
    hits, Date: { now: () => time }, setTimeout: later, clearTimeout: id => timers.delete(id),
    lx: {
      EVENT_NAMES: { request: 'request', inited: 'inited' },
      on(_event, fn) { handler = fn; }, send() {},
      request(url, _options, reply) {
        const status = typeof headStatus === 'function' ? headStatus(url) : headStatus;
        reply(null, { statusCode: status, headers: { 'content-type': 'audio/mpeg' } });
        return () => {};
      },
    },
  });
  const play = (song, platform = 'kg', quality = '128k') => handler({
    action: 'musicUrl', source: platform, info: { type: quality, musicInfo: { id: song } },
  });
  return { advance, hits, play };
}

const stalled = 'return new Promise(() => {});';
const valid = 'return ' + JSON.stringify(media) + ';';

test('two stalled resolvers leave time for a third group in the 16-second route', async () => {
  const runner = harness([{ name: 'first', body: stalled }, { name: 'second', body: stalled }, { name: 'third', body: valid }]);
  const playback = runner.play('song');
  await runner.advance(16000);
  assert.deepEqual(runner.hits.map(([name]) => name), ['first', 'second', 'third']);
  assert.ok(runner.hits[2][2] < 16000);
  assert.equal(await playback, media);
});

test('a second track can use an idle provider while a stalled track occupies the primary', async () => {
  const runner = harness([{ name: 'primary', body: stalled }, { name: 'fallback', body: valid }]);
  const first = runner.play('one'), second = runner.play('two');
  await runner.advance(0);
  assert.deepEqual(runner.hits.map(([name, song]) => [name, song]), [['primary', 'one'], ['fallback', 'two']]);
  assert.equal(await second, media);
  await runner.advance(8000);
  assert.equal(await first, media);
});

test('three simultaneous songs share a sole provider in order without overlapping its handler', async () => {
  const runner = harness([{ name: 'only', body: 'await new Promise(resolve => setTimeout(resolve, 900)); ' + valid }]);
  const playback = Promise.all(['a', 'b', 'c'].map(song => runner.play(song)));
  await runner.advance(3000);
  assert.deepEqual(runner.hits.map(([, song, start]) => [song, start]), [['a', 0], ['b', 900], ['c', 1800]]);
  assert.deepEqual(await playback, [media, media, media]);
});

test('a cooling provider leaves its group available to a healthy sibling', async () => {
  const runner = harness([
    { name: 'flaky', group: 'group', body: 'throw new Error("absent");' },
    { name: 'sibling', group: 'group', body: valid },
    { name: 'external', body: valid },
  ]);
  await runner.play('a');
  await runner.play('b');
  assert.equal(await runner.play('c'), media);
  assert.deepEqual(runner.hits.map(([name]) => name), ['flaky', 'external', 'flaky', 'external', 'sibling']);
});

test('a transiently cooling sole group can recover immediately and a HEAD 405 preserves its URL', async () => {
  const runner = harness([{ name: 'only', body: 'if (song !== "available") throw new Error("absent"); ' + valid }], { headStatus: 405 });
  await assert.rejects(runner.play('a'), /absent/);
  await assert.rejects(runner.play('b'), /absent/);
  assert.equal(await runner.play('available'), media);
});

const providerUrl = (name, url) => ({ name, body: 'return ' + JSON.stringify(url) + ';' });
const primaryUrl = 'https://cdn.invalid/music/one?sig=a';
const duplicateUrl = 'https://CDN.invalid:443/music/two?sig=b';
const otherUrl = 'https://other-cdn.invalid/music/one?sig=c';

test('a quick re-resolution tries another group, skips its duplicate media hostname and delivers a distinct hostname', async () => {
  const runner = harness([
    providerUrl('primary', primaryUrl), providerUrl('alias', duplicateUrl), providerUrl('alternate', otherUrl),
  ]);
  assert.equal(await runner.play('sample'), primaryUrl);
  assert.equal(await runner.play('sample'), otherUrl);
  assert.deepEqual(runner.hits.map(([name]) => name), ['primary', 'alias', 'alternate']);
  assert.equal(await runner.play('another'), primaryUrl);
  assert.equal(await runner.play('sample', 'kw'), primaryUrl);
  assert.equal(await runner.play('sample', 'kg', '320k'), primaryUrl);
  await runner.advance(90001);
  assert.equal(await runner.play('sample'), primaryUrl);
});

test('a distinct CDN declining HEAD outranks a previously handed out host, and a sole valid host is reusable', async () => {
  const runner = harness([
    providerUrl('primary', primaryUrl), providerUrl('alias', duplicateUrl), providerUrl('other', otherUrl),
  ], { headStatus: url => url === otherUrl ? 405 : 200 });
  assert.equal(await runner.play('one'), primaryUrl);
  assert.equal(await runner.play('one'), otherUrl);
  const only = harness([providerUrl('a', primaryUrl), providerUrl('alias', duplicateUrl)]);
  assert.equal(await only.play('one'), primaryUrl);
  assert.equal(await only.play('one'), duplicateUrl);
  const sole = harness([providerUrl('a', primaryUrl)], { headStatus: 501 });
  assert.equal(await sole.play('one'), primaryUrl);
  assert.equal(await sole.play('one'), primaryUrl);
});

test('concurrent requests for the same song use a fresh delivery when their first results point to one CDN', async () => {
  const runner = harness([
    providerUrl('first', primaryUrl), providerUrl('shared', duplicateUrl), providerUrl('fresh', otherUrl),
  ]);
  const results = await Promise.all([runner.play('one'), runner.play('one')]);
  assert.deepEqual(results.sort(), [primaryUrl, otherUrl].sort());
});

test('retry history evicts an old song after 64 distinct newer deliveries', async () => {
  const runner = harness([providerUrl('primary', primaryUrl), providerUrl('alternate', otherUrl)]);
  assert.equal(await runner.play('target'), primaryUrl);
  for (let i = 0; i < 64; i++) await runner.play('other-' + i);
  assert.equal(await runner.play('target'), primaryUrl);
});
