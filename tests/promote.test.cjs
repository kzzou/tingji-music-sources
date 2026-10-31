'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { inspect, promote } = require('../scripts/promote.cjs')
const digest = (algorithm, bytes) => crypto.createHash(algorithm).update(bytes).digest('hex')
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tingji-promotion-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const candidate = path.join(root, 'candidate')
  const target = path.join(root, 'target')
  fs.mkdirSync(path.join(candidate, 'sources'), { recursive: true })
  fs.mkdirSync(target)
  // If executed this would fail. The publisher may only compile these bytes.
  const script = Buffer.from('throw new Error("must never execute");\n')
  const sha256 = digest('sha256', script)
  const manifest = { schemaVersion: 1, version: 'test-1', generatedAt: '2026-10-30T00:00:00Z', source: { path: `sources/${sha256}.js`, sha256, sha1: digest('sha1', script), bytes: script.length }, capabilities: { kg: ['128k'] }, upstreams: [{ repository: 'test/source', commit: 'a'.repeat(40), path: 'latest.js', sha256 }] }
  fs.writeFileSync(path.join(candidate, manifest.source.path), script)
  const write = () => fs.writeFileSync(path.join(candidate, 'manifest.json'), JSON.stringify(manifest))
  write()
  return { root, candidate, target, manifest, write }
}
test('promotes verified bytes, preserves previous pointer, and does not execute code', t => {
  const f = fixture(t)
  const previous = JSON.stringify({ source: { sha256: '0'.repeat(64) } })
  fs.writeFileSync(path.join(f.target, 'manifest.json'), previous)
  assert.equal(promote(f.candidate, f.target), true)
  assert.equal(fs.readFileSync(path.join(f.target, 'previous-manifest.json'), 'utf8'), previous)
  assert.equal(inspect(f.target).manifest.source.sha256, f.manifest.source.sha256)
  assert.equal(promote(f.candidate, f.target), false)
})
test('rejects corrupt artifacts before touching an existing release', t => {
  const f = fixture(t)
  fs.writeFileSync(path.join(f.target, 'manifest.json'), '{"old":true}')
  fs.appendFileSync(path.join(f.candidate, f.manifest.source.path), 'corruption')
  assert.throws(() => promote(f.candidate, f.target), /integrity/)
  assert.equal(fs.readFileSync(path.join(f.target, 'manifest.json'), 'utf8'), '{"old":true}')
})
test('rejects traversal and unknown capabilities', t => {
  const f = fixture(t)
  f.manifest.source.path = '../escaped.js'; f.write()
  assert.throws(() => inspect(f.candidate), /address/)
  f.manifest.source.path = `sources/${f.manifest.source.sha256}.js`
  f.manifest.capabilities = { kg: ['premium'] }; f.write()
  assert.throws(() => inspect(f.candidate), /capabilities/)
})
test('allows a larger multi-platform bundle while enforcing the mobile provider limit', t => {
  const f = fixture(t)
  f.manifest.capabilities = { kg: ['128k'], tx: ['128k'], kw: ['128k'] }
  f.manifest.upstreams = Array.from({ length: 24 }, (_, index) => ({ ...f.manifest.upstreams[0], path: `provider-${index}.js` }))
  f.write()
  assert.equal(inspect(f.candidate).manifest.upstreams.length, 24)
  f.manifest.upstreams.push({ ...f.manifest.upstreams[0], path: 'overflow.js' }); f.write()
  assert.throws(() => inspect(f.candidate), /provenance/)
})
test('discovery and publisher agree on the upstream path boundary', t => {
  const { sourcePaths } = require('../lib/discovery.cjs')
  const f = fixture(t)
  const accepted = 'a/'.repeat(248) + 'b.js'
  const rejected = 'a/'.repeat(248) + 'bb.js'
  const entry = path => ({ path, type: 'blob', mode: '100644', size: 100 })
  assert.equal(accepted.length, 500)
  assert.deepEqual(sourcePaths([entry(accepted), entry(rejected)]).map(item => item.path), [accepted])
  f.manifest.upstreams[0].path = accepted; f.write()
  assert.equal(inspect(f.candidate).manifest.upstreams[0].path, accepted)
  f.manifest.upstreams[0].path = rejected; f.write()
  assert.throws(() => inspect(f.candidate), /provenance/)
})
