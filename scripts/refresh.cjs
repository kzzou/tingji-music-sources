#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { discover } = require('../lib/discovery.cjs');
const { digest, compileVerified, writeOutput, sanitizeDiagnostics } = require('../lib/publisher.cjs');
const { inspectSources } = require('../lib/generator.cjs');
const root = path.resolve(__dirname, '..');
const output = path.resolve(process.env.TINGJI_OUTPUT_DIR || path.join(root, 'output'));

function runProbe(file) {
  const child = spawnSync(process.execPath, [path.join(root, 'lib/probe.cjs'), file], {
    // Deliberately exclude GH_TOKEN, GITHUB_TOKEN, HOME and runner credentials.
    env: { PATH: process.env.PATH || '', CI: 'true', GITHUB_ACTIONS: 'true', TZ: 'UTC', SYSTEMROOT: process.env.SYSTEMROOT || '' },
    cwd: path.dirname(file), timeout: 48000, maxBuffer: 256 * 1024, encoding: 'utf8', windowsHide: true,
  });
  if (child.error || child.status !== 0) return { runtimeError: child.error?.code || 'probe failed' };
  try { return JSON.parse(child.stdout.trim()); } catch { return { runtimeError: 'invalid probe result' }; }
}

async function main() {
  const catalogOnly = process.argv.includes('--catalog-only');
  if (!catalogOnly && (process.env.CI !== 'true' || process.env.GITHUB_ACTIONS !== 'true')) throw Error('Run downloaded source validation in the no-secret CI validator; use --catalog-only for local discovery');
  writeOutput(output, null);
  const events = [];
  const candidates = await discover({ search: !process.argv.includes('--seed-only'), report: event => events.push(event) });
  const diagnostics = { discoveredAt: new Date().toISOString(), candidateCount: candidates.length, events, candidates: [] };
  if (catalogOnly) {
    fs.writeFileSync(path.join(output, 'catalog.json'), JSON.stringify(candidates.map(({ rawCode, ...item }) => item), null, 2));
    console.log(`Discovered ${candidates.length} newest distinct candidate(s); no downloaded code executed.`);
    return;
  }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tingji-source-check-'));
  try {
    for (const [index, item] of candidates.entries()) {
      const cleaned = inspectSources([{ ...item, id: `candidate-${index + 1}` }]);
      if (cleaned.sources.length) {
        // Test the exact one-provider bundle, including field adaptation and capability limits.
        const preliminary = { ...item, verification: { init: { status: true }, quality: '128k', resolves: [{ requestKey: 'sample', status: true }], media: { status: 206, bytes: 32, audioHeader: true } } };
        const testBundle = compileVerified([preliminary]);
        const file = path.join(temp, `${index + 1}.js`);
        fs.writeFileSync(file, testBundle.script);
        item.verification = runProbe(file);
        delete item.verification.requests; // Never publish provider request paths or signed media URLs.
      } else item.verification = { runtimeError: 'static inspection rejected candidate' };
      diagnostics.candidates.push({ repository: item.repository, commit: item.commit, path: item.path, sha256: digest(item.rawCode), verification: item.verification });
    }
    let result = compileVerified(candidates);
    if (result) {
      const aggregateFile = path.join(temp, 'aggregate.js');
      fs.writeFileSync(aggregateFile, result.script);
      const aggregate = runProbe(aggregateFile);
      const { audioVerified } = require('../lib/publisher.cjs');
      diagnostics.aggregate = aggregate;
      if (!audioVerified(aggregate)) result = null;
    }
    const published = writeOutput(output, result);
    diagnostics.readyToPublish = published;
    fs.writeFileSync(path.join(output, 'diagnostics.json'), JSON.stringify(sanitizeDiagnostics(diagnostics), null, 2) + '\n');
    console.log(published ? `Verified source prepared: ${result.manifest.source.sha256}, ${result.manifest.upstreams.length} provider(s), kg/128k` : 'No candidate passed audio verification. Preserve the live manifest and source.');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { runProbe };
