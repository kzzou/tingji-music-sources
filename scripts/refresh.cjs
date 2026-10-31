#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { MAX_CANDIDATES, PLATFORMS, digest, compileVerified, preliminaryBundle, audioVerified, capabilitiesFor, writeOutput, sanitizeDiagnostics } = require('../lib/publisher.cjs');
const { inspectSources, MAX_SOURCE_BYTES } = require('../lib/generator.cjs');
const root = path.resolve(__dirname, '..');
const PROBE_CONCURRENCY = 3;
const CANDIDATE_BUDGET_MS = 28 * 60 * 1000;

function loadCatalog(directory) {
  if (!directory) throw Error('TINGJI_CATALOG_DIR is required; discover candidates before starting the no-secret validator');
  const base = fs.realpathSync(directory);
  const read = (file, limit) => {
    const target = path.join(base, file);
    const info = fs.lstatSync(target);
    const relative = path.relative(base, fs.realpathSync(target));
    if (!info.isFile() || info.isSymbolicLink() || relative.startsWith('..') || path.isAbsolute(relative) || info.size > limit) throw Error('Unsafe or oversized catalog file');
    return fs.readFileSync(target);
  };
  const catalog = JSON.parse(read('catalog.json', 256 * 1024).toString('utf8'));
  if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.candidates) || catalog.candidates.length > MAX_CANDIDATES) throw Error('Invalid discovery catalog');
  const seen = new Set();
  return catalog.candidates.map(item => {
    if (!item || !/^[\w.-]+\/[\w.-]+$/.test(item.repository) || !/^[a-f0-9]{40}$/.test(item.commit) || typeof item.path !== 'string' || item.path.length > 500 || item.path.startsWith('/') || item.path.includes('\\') || item.path.split('/').some(part => !part || part === '..' || part === '.') || !/\.js$/i.test(item.path) || !Number.isFinite(Date.parse(item.updatedAt)) || !/^[a-f0-9]{64}$/.test(item.sha256) || item.file !== `scripts/${item.sha256}.js` || !Number.isSafeInteger(item.bytes) || item.bytes < 1 || item.bytes > MAX_SOURCE_BYTES) throw Error('Invalid discovery catalog candidate');
    const bytes = read(item.file, MAX_SOURCE_BYTES);
    const rawCode = bytes.toString('utf8');
    if (bytes.length !== item.bytes || digest(bytes) !== item.sha256 || !Buffer.from(rawCode, 'utf8').equals(bytes)) throw Error('Discovery script bytes/hash mismatch');
    if (seen.has(item.sha256)) return null;
    seen.add(item.sha256);
    return { ...item, rawCode };
  }).filter(Boolean);
}

async function mapLimit(items, maximum, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(maximum, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }));
  return results;
}

function runProbe(file, platform = 'kg', fixtureFile = path.join(root, 'fixtures/platforms.json'), sampleIndex) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['--max-old-space-size=192', path.join(root, 'lib/probe.cjs'), file, platform, 'modern', fixtureFile, sampleIndex === undefined ? 'auto' : String(sampleIndex)], {
      env: { PATH: process.env.PATH || '', CI: 'true', GITHUB_ACTIONS: 'true', TZ: 'UTC', SYSTEMROOT: process.env.SYSTEMROOT || '' },
      cwd: path.dirname(file), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let text = '', bytes = 0, finished = false;
    const finish = result => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish({ platform, runtimeError: '48-second probe deadline' }); }, 48_000);
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 256 * 1024) { child.kill('SIGKILL'); finish({ platform, runtimeError: 'probe output exceeds limit' }); }
      else text += chunk.toString('utf8');
    });
    child.stderr.resume();
    child.on('error', error => finish({ platform, runtimeError: error.code || 'probe failed' }));
    child.on('close', status => {
      if (status !== 0) return finish({ platform, runtimeError: 'probe failed' });
      try { finish({ ...JSON.parse(text.trim()), platform }); } catch { finish({ platform, runtimeError: 'invalid probe result' }); }
    });
  });
}

function fixturePlatforms(fixtures) {
  return PLATFORMS.filter(platform => {
    const row = Array.isArray(fixtures[platform]) ? fixtures[platform][0] : fixtures[platform];
    return row?.modern?.source === platform && row.modern.meta?.songId != null && row.legacy;
  });
}

async function validateCandidates(candidates, platforms, temp, fixtureFile, probe = runProbe, budgetMs = CANDIDATE_BUDGET_MS) {
  const deadline = Date.now() + budgetMs;
  const tasks = [];
  for (const [index, item] of candidates.entries()) {
    item.verification = [];
    const cleaned = inspectSources([{ ...item, id: `candidate-${index + 1}` }]);
    if (!cleaned.sources.length) { item.verification.push({ runtimeError: 'static inspection rejected candidate' }); continue; }
    try {
      const file = path.join(temp, `candidate-${index + 1}.js`);
      fs.writeFileSync(file, preliminaryBundle(item, platforms));
      for (const platform of platforms) tasks.push({ item, file, platform });
    } catch (error) { item.verification.push({ runtimeError: error.message }); }
  }
  await mapLimit(tasks, PROBE_CONCURRENCY, async task => {
    if (Date.now() >= deadline) {
      task.item.verification.push({ platform: task.platform, runtimeError: 'candidate validation time budget exhausted' });
      return;
    }
    const report = await probe(task.file, task.platform, fixtureFile);
    delete report.requests;
    task.item.verification.push({ ...report, platform: task.platform });
  });
  for (const item of candidates) item.verification.sort((a, b) => PLATFORMS.indexOf(a.platform) - PLATFORMS.indexOf(b.platform));
  return candidates;
}

async function validateAggregate(candidates, temp, fixtureFile, diagnostics, probe = runProbe) {
  const date = new Date();
  let result = compileVerified(candidates, date);
  diagnostics.aggregate = [];
  for (let round = 0; result && round <= PLATFORMS.length; round++) {
    const file = path.join(temp, `aggregate-${round}.js`);
    fs.writeFileSync(file, result.script);
    const reports = await mapLimit(Object.keys(result.manifest.capabilities), PROBE_CONCURRENCY, async platform => {
      const first = await probe(file, platform, fixtureFile);
      // A transient first winner failure must not discard other individually
      // verified fallbacks without a second attempt of the complete bundle.
      return audioVerified(first) ? first : probe(file, platform, fixtureFile);
    });
    diagnostics.aggregate.push({ round, reports });
    const allowedCapabilities = capabilitiesFor(reports);
    if (Object.keys(allowedCapabilities).length === Object.keys(result.manifest.capabilities).length) return result;
    if (!Object.keys(allowedCapabilities).length) return null;
    result = compileVerified(candidates, date, { allowedCapabilities });
  }
  return null;
}

async function main() {
  if (process.argv.includes('--catalog-only')) {
    const child = spawnSync(process.execPath, [path.join(root, 'scripts/discover.cjs'), ...process.argv.slice(2).filter(value => value !== '--catalog-only')], { stdio: 'inherit', windowsHide: true, env: process.env });
    if (child.status !== 0) throw Error('Discovery failed');
    return;
  }
  if (process.env.CI !== 'true' || process.env.GITHUB_ACTIONS !== 'true') throw Error('Run downloaded source validation in the no-secret CI validator');
  const output = path.resolve(process.env.TINGJI_OUTPUT_DIR || path.join(root, 'output'));
  writeOutput(output, null);
  const candidates = loadCatalog(process.env.TINGJI_CATALOG_DIR);
  const fixtureFile = path.resolve(process.env.TINGJI_FIXTURE_PATH || path.join(root, 'fixtures/platforms.json'));
  const fixtures = JSON.parse(fs.readFileSync(fixtureFile, 'utf8'));
  const platforms = fixturePlatforms(fixtures);
  if (!platforms.length) throw Error('No verified public song fixtures available');
  const diagnostics = { discoveredAt: new Date().toISOString(), candidateCount: candidates.length, platforms, concurrency: PROBE_CONCURRENCY, candidates: [] };
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tingji-source-check-'));
  try {
    await validateCandidates(candidates, platforms, temp, fixtureFile);
    diagnostics.candidates = candidates.map(({ rawCode, ...item }) => item);
    const result = await validateAggregate(candidates, temp, fixtureFile, diagnostics);
    const published = writeOutput(output, result);
    diagnostics.readyToPublish = published;
    if (result) diagnostics.selection = result.report;
    fs.writeFileSync(path.join(output, 'diagnostics.json'), JSON.stringify(sanitizeDiagnostics(diagnostics), null, 2) + '\n');
    console.log(published ? `Verified source prepared: ${result.manifest.source.sha256}, ${result.manifest.upstreams.length} provider(s), ${Object.keys(result.manifest.capabilities).join(',')}/128k` : 'No candidate passed audio verification. Preserve the live manifest and source.');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { PROBE_CONCURRENCY, CANDIDATE_BUDGET_MS, loadCatalog, mapLimit, runProbe, fixturePlatforms, validateCandidates, validateAggregate };
