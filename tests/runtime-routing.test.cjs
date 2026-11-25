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
  const sources = { kg: { type: 'music', actions: ['musicUrl'], qualitys: ['128k'] } };
  const inputs = rows.map(({ name, body, group }) => ({
    id: name, endpointGroup: group, verifiedCapabilities: { kg: ['128k'] },
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
      request(_url, _options, reply) {
        reply(null, { statusCode: headStatus, headers: { 'content-type': 'audio/mpeg' } });
        return () => {};
      },
    },
  });
  const play = song => handler({ action: 'musicUrl', source: 'kg', info: { type: '128k', musicInfo: { id: song } } });
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
  const playback = Promise.all(['a', 'b', 'c'].map(runner.play));
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
