'use strict'

// Trusted publisher: validates bytes and metadata without executing downloaded scripts.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const vm = require('node:vm')

const MAX_BYTES = 6 * 1024 * 1024
const allowed = new Set(['kw', 'kg', 'tx', 'wy', 'mg'])
const qualities = new Set(['128k', '320k', 'flac', 'flac24bit'])
const hash = (algorithm, bytes) => crypto.createHash(algorithm).update(bytes).digest('hex')

function readRegular(root, relative, maxBytes) {
  let current = path.resolve(root)
  for (const part of relative.split('/')) {
    if (!part || part === '.' || part === '..') throw new Error('Invalid artifact path')
    current = path.join(current, part)
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Symbolic links are not artifacts')
  }
  const stat = fs.statSync(current)
  if (!stat.isFile() || stat.size > maxBytes) throw new Error('Invalid artifact size')
  return fs.readFileSync(current)
}

function inspect(root) {
  const bytes = readRegular(root, 'manifest.json', 64 * 1024)
  const manifest = JSON.parse(bytes.toString('utf8'))
  if (manifest.schemaVersion !== 1 || typeof manifest.version !== 'string' || !/^[\w.-]{1,80}$/.test(manifest.version)) throw new Error('Invalid version')
  if (typeof manifest.generatedAt !== 'string' || !Number.isFinite(Date.parse(manifest.generatedAt))) throw new Error('Invalid timestamp')
  const source = manifest.source
  if (!source || !/^[a-f0-9]{64}$/.test(source.sha256) || !/^[a-f0-9]{40}$/.test(source.sha1) || source.path !== `sources/${source.sha256}.js`) throw new Error('Invalid source address')
  if (!Number.isSafeInteger(source.bytes) || source.bytes < 1 || source.bytes > MAX_BYTES) throw new Error('Invalid source length')
  const script = readRegular(root, source.path, MAX_BYTES)
  if (script.length !== source.bytes || hash('sha256', script) !== source.sha256 || hash('sha1', script) !== source.sha1) throw new Error('Artifact integrity failed')
  new vm.Script(script.toString('utf8'), { filename: 'subscription.js' }) // Compile only.
  const caps = manifest.capabilities
  if (!caps || typeof caps !== 'object' || Array.isArray(caps) || !Object.keys(caps).length || Object.keys(caps).some(key => !allowed.has(key) || !Array.isArray(caps[key]) || !caps[key].length || caps[key].some(value => !qualities.has(value)))) throw new Error('Invalid verified capabilities')
  if (!Array.isArray(manifest.upstreams) || manifest.upstreams.length < 1 || manifest.upstreams.length > 10) throw new Error('Invalid provenance')
  for (const upstream of manifest.upstreams) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(upstream.repository) || !/^[a-f0-9]{40}$/.test(upstream.commit) || !/^[a-f0-9]{64}$/.test(upstream.sha256) || typeof upstream.path !== 'string' || upstream.path.length > 500 || /[\x00-\x1f]/.test(upstream.path)) throw new Error('Invalid upstream provenance')
  }
  return { manifest, script }
}

function promote(candidateRoot, targetRoot) {
  const { manifest, script } = inspect(candidateRoot)
  const target = path.resolve(targetRoot)
  const manifestPath = path.join(target, 'manifest.json')
  const current = fs.existsSync(manifestPath) ? fs.readFileSync(manifestPath) : undefined
  if (current && JSON.parse(current).source.sha256 === manifest.source.sha256) return false
  fs.mkdirSync(path.join(target, 'sources'), { recursive: true })
  const destination = path.join(target, manifest.source.path)
  if (fs.existsSync(destination)) {
    if (hash('sha256', fs.readFileSync(destination)) !== manifest.source.sha256) throw new Error('Immutable artifact collision')
  } else fs.writeFileSync(destination, script, { flag: 'wx' })
  if (current) fs.writeFileSync(path.join(target, 'previous-manifest.json'), current)
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  return true
}

if (require.main === module) {
  const changed = promote(process.argv[2] || 'output', process.argv[3] || '.')
  console.log(changed ? 'Verified subscription promoted.' : 'Identical subscription; no publication needed.')
}
module.exports = { inspect, promote }
