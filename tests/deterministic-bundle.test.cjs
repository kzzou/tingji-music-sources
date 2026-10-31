const { test } = require('node:test')
const assert = require('node:assert/strict')
const { compileVerified } = require('../lib/publisher.cjs')

test('concurrent platform completion order cannot change an otherwise identical source bundle', () => {
  const rawCode = '/*!\n * @name Stable source\n */\nlx.on(lx.EVENT_NAMES.request,async()=>"https://example.com/song.mp3");lx.send(lx.EVENT_NAMES.inited,{sources:{kg:{type:"music",actions:["musicUrl"],qualitys:["128k"]},tx:{type:"music",actions:["musicUrl"],qualitys:["128k"]}}});'
  const report = platform => ({ platform, init: { status: true }, quality: '128k', resolves: [{ requestKey: 'sample', status: true }], media: { status: 206, bytes: 8192, audioHeader: true }, sample: { name: 'sample', songId: platform, index: 0 } })
  const candidate = { repository: 'test/source', commit: 'a'.repeat(40), path: 'source.js', rawCode }
  const first = compileVerified([{ ...candidate, verification: [report('kg'), report('tx')] }])
  const reversed = compileVerified([{ ...candidate, verification: [report('tx'), report('kg')] }])
  assert.equal(first.script, reversed.script)
  assert.equal(first.manifest.source.sha256, reversed.manifest.source.sha256)
})
