'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { generateSourceBundle, inspectSources } = require('./generator.cjs');
const MAX_CANDIDATES = 10;
const digest = (value, algorithm = 'sha256') => crypto.createHash(algorithm).update(value).digest('hex');

function selectNewestUnique(candidates, maximum = MAX_CANDIDATES) {
  const seen = new Set();
  // A bulk upstream commit gives many files the exact same update time. Prefer
  // previously compatible families only within that tie; newer files still win.
  const tiePriority = item => /(^|\/)xinghai\//.test(item.path) ? 0 : /(^|\/)hyw\//.test(item.path) ? 1 : /(^|\/)helloworld\//.test(item.path) ? 2 : 10;
  return candidates.filter(item => item && typeof item.rawCode === 'string')
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || tiePriority(a) - tiePriority(b) || `${a.repository}/${a.path}`.localeCompare(`${b.repository}/${b.path}`))
    .filter(item => {
      const hash = digest(item.rawCode);
      if (seen.has(hash)) return false;
      seen.add(hash);
      item.sha256 = hash;
      return true;
    }).slice(0, maximum);
}

function audioVerified(report) {
  return report?.init?.status === true && report?.quality === '128k'
    && report?.resolves?.some(result => result.requestKey === 'sample' && result.status === true)
    && [200, 206].includes(report?.media?.status)
    && report?.media?.bytes >= 32 && report?.media?.audioHeader === true
    && !report?.runtimeError && !report?.resolveError && !report?.media?.error;
}

function sanitizeDiagnostics(value) {
  return JSON.parse(JSON.stringify(value, (key, item) => {
    if (/(?:token|cookie|authorization|api.?key|secret|password|(?:^|_)url$)/i.test(key)) return '[redacted]';
    if (key === 'requests') return undefined;
    if (typeof item !== 'string') return item;
    return item.replace(/https?:\/\/[^\s"'<>]+/gi, '[URL]')
      .replace(/((?:token|cookie|authorization|api.?key|secret|password)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]').slice(0, 1800);
  }));
}

function compileVerified(candidates, date = new Date()) {
  const verified = candidates.filter(item => audioVerified(item.verification));
  if (!verified.length) return null;
  const inputs = verified.map((item, index) => ({
    id: `verified-${index + 1}`,
    path: `${item.repository}@${item.commit}/${item.path}`,
    sha256: digest(item.rawCode), rawCode: item.rawCode,
    musicInfoMode: 'enriched', priority: index,
    verifiedCapabilities: { kg: ['128k'] },
  }));
  const inspected = inspectSources(inputs);
  if (!inspected.sources.length) return null;
  const { script, report } = generateSourceBundle(inspected.sources, { name: '听己每日可用源', timeoutMs: 8000 });
  const sha256 = digest(script);
  const generatedAt = date.toISOString();
  const manifest = {
    schemaVersion: 1, version: `${generatedAt.replace(/[-:.]/g, '')}-${sha256.slice(0, 12)}`,
    generatedAt,
    source: { path: `sources/${sha256}.js`, sha256, sha1: digest(script, 'sha1'), bytes: Buffer.byteLength(script) },
    capabilities: { kg: ['128k'] },
    verification: { platform: 'kg', quality: '128k', sample: '不死鸟 — 霍尊', check: 'musicUrl + HTTP GET audio magic', testedAt: generatedAt },
    upstreams: verified.filter(item => inspected.sources.some(source => source.sha256 === digest(item.rawCode))).map(item => ({
      repository: item.repository, commit: item.commit, path: item.path,
      sha256: digest(item.rawCode), updatedAt: item.updatedAt,
    })),
  };
  return { manifest, script, report };
}

function writeOutput(outputDirectory, result) {
  // This directory is a disposable validator artifact. Never delete the live feed here.
  fs.mkdirSync(outputDirectory, { recursive: true });
  const pending = path.join(outputDirectory, 'manifest.json');
  if (fs.existsSync(pending)) fs.unlinkSync(pending);
  if (!result) return false;
  fs.mkdirSync(path.join(outputDirectory, 'sources'), { recursive: true });
  fs.writeFileSync(path.join(outputDirectory, result.manifest.source.path), result.script);
  fs.writeFileSync(pending, JSON.stringify(result.manifest, null, 2) + '\n');
  return true;
}

module.exports = { MAX_CANDIDATES, digest, selectNewestUnique, audioVerified, sanitizeDiagnostics, compileVerified, writeOutput };
