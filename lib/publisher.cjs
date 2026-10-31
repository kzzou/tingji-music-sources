'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { generateSourceBundle, inspectSources, MAX_SOURCE_COUNT } = require('./generator.cjs');
const MAX_CANDIDATES = 30;
const PLATFORMS = ['kg', 'tx', 'kw', 'wy', 'mg'];
const digest = (value, algorithm = 'sha256') => crypto.createHash(algorithm).update(value).digest('hex');

function selectNewestUnique(candidates, maximum = MAX_CANDIDATES) {
  const seen = new Set();
  const tiePriority = item => /(^|\/)xinghai\//.test(item.path) ? 0 : /(^|\/)hyw\//.test(item.path) ? 1 : /(^|\/)helloworld\//.test(item.path) ? 2 : 10;
  return candidates.filter(item => item && typeof item.rawCode === 'string')
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || tiePriority(a) - tiePriority(b) || `${a.repository}/${a.path}`.localeCompare(`${b.repository}/${b.path}`))
    .filter(item => {
      const hash = digest(item.rawCode);
      if (seen.has(hash)) return false;
      seen.add(hash); item.sha256 = hash; return true;
    }).slice(0, maximum);
}

function audioVerified(report) {
  return report?.init?.status === true && report?.quality === '128k'
    && report?.resolves?.some(result => result.requestKey === 'sample' && result.status === true)
    && [200, 206].includes(report?.media?.status)
    && report?.media?.bytes >= 32 && report?.media?.audioHeader === true
    && !report?.runtimeError && !report?.resolveError && !report?.media?.error;
}

function normalizeVerifiedReports(value) {
  if (Array.isArray(value)) return value.flatMap(normalizeVerifiedReports);
  if (!value || typeof value !== 'object') return [];
  if (value.init) return audioVerified(value) && PLATFORMS.includes(value.platform || 'kg') ? [{ ...value, platform: value.platform || 'kg' }] : [];
  if (value.reports) return normalizeVerifiedReports(value.reports);
  if (value.verification) return normalizeVerifiedReports(value.verification);
  return PLATFORMS.flatMap(platform => {
    const entry = value[platform];
    return entry ? normalizeVerifiedReports(Array.isArray(entry) ? entry.map(report => ({ ...report, platform })) : { ...entry, platform }) : [];
  });
}

function capabilitiesFor(reports, allowed) {
  const result = {};
  for (const report of normalizeVerifiedReports(reports)) {
    if (allowed && !allowed[report.platform]?.includes(report.quality)) continue;
    result[report.platform] = ['128k'];
  }
  return Object.fromEntries(PLATFORMS.filter(platform => result[platform]).map(platform => [platform, result[platform]]));
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

function providerInput(item, index, capabilities) {
  const reports = normalizeVerifiedReports(item.verification);
  const platformPriorities = {};
  for (const platform of Object.keys(capabilities)) {
    const matching = reports.filter(report => report.platform === platform);
    if (matching.length) platformPriorities[platform] = Math.min(...matching.map(report => report.sample?.requested === true ? 0 : (report.sample?.index ?? 0) === 0 ? 10 : 100)) + index / 1000;
  }
  return {
    id: `verified-${index + 1}`, path: `${item.repository}@${item.commit}/${item.path}`,
    sha256: digest(item.rawCode), rawCode: item.rawCode,
    musicInfoMode: 'enriched', priority: index, platformPriorities, verifiedCapabilities: capabilities,
  };
}

function preliminaryBundle(item, platforms) {
  const allowed = Object.fromEntries(platforms.filter(platform => PLATFORMS.includes(platform)).map(platform => [platform, ['128k']]));
  // An isolated test wrapper; this does not assert successful audio verification.
  return generateSourceBundle([providerInput(item, 0, allowed)], { name: '听己候选验证', timeoutMs: 8000 }).script;
}

function compileVerified(candidates, date = new Date(), options = {}) {
  const prepared = [], rejected = [];
  const seen = new Set();
  for (const [index, item] of candidates.entries()) {
    const verifiedCapabilities = capabilitiesFor(item.verification, options.allowedCapabilities);
    if (!Object.keys(verifiedCapabilities).length) continue;
    const hash = digest(item.rawCode);
    if (seen.has(hash)) continue;
    const inspected = inspectSources([providerInput(item, index, verifiedCapabilities)]);
    if (!inspected.sources.length) { rejected.push(...inspected.rejected); continue; }
    seen.add(hash);
    prepared.push({ item, input: inspected.sources[0], index, proofs: normalizeVerifiedReports(item.verification).filter(report => verifiedCapabilities[report.platform]) });
  }
  if (!prepared.length) return null;
  const selected = [], covered = new Set(), coveredRequested = new Set(), coveredFirst = new Set();
  const sampleKey = report => `${report.platform}:${report.sample?.songId ?? report.sample?.name ?? 'first'}`;
  const requested = row => [...new Set(row.proofs.filter(report => report.sample?.requested === true).map(sampleKey))];
  const firstSamples = row => [...new Set(row.proofs.filter(report => (report.sample?.index ?? 0) === 0).map(sampleKey))];
  const uncovered = (keys, existing) => keys.filter(key => !existing.has(key)).length;
  let bundle;
  while (prepared.length && selected.length < MAX_SOURCE_COUNT) {
    const added = row => Object.keys(row.input.verifiedCapabilities).filter(platform => !covered.has(platform)).length;
    prepared.sort((a, b) => uncovered(requested(b), coveredRequested) - uncovered(requested(a), coveredRequested) || added(b) - added(a) || uncovered(firstSamples(b), coveredFirst) - uncovered(firstSamples(a), coveredFirst) || Buffer.byteLength(a.item.rawCode) - Buffer.byteLength(b.item.rawCode) || a.index - b.index);
    const row = prepared.shift();
    try {
      const next = generateSourceBundle([...selected.map(entry => entry.input), row.input], { name: '听己每日可用源', timeoutMs: 8000 });
      selected.push(row); bundle = next;
      for (const platform of Object.keys(row.input.verifiedCapabilities)) covered.add(platform);
      for (const key of requested(row)) coveredRequested.add(key);
      for (const key of firstSamples(row)) coveredFirst.add(key);
    } catch (error) { rejected.push({ name: row.input.name, reason: error.message }); }
  }
  for (const row of prepared) rejected.push({ name: row.input.name, reason: `mobile provider count exceeds ${MAX_SOURCE_COUNT}` });
  if (!bundle) return null;
  const capabilities = Object.fromEntries(PLATFORMS.filter(platform => covered.has(platform)).map(platform => [platform, ['128k']]));
  const { script, report } = bundle;
  report.rejected.push(...rejected);
  const sha256 = digest(script), generatedAt = date.toISOString();
  const samples = [], sampleKeys = new Set();
  for (const row of selected) {
    for (const verified of normalizeVerifiedReports(row.item.verification)) {
      if (!capabilities[verified.platform] || !row.input.verifiedCapabilities[verified.platform]) continue;
      const sample = { platform: verified.platform, quality: verified.quality, ...verified.sample };
      const key = JSON.stringify(sample);
      if (!sampleKeys.has(key)) { samples.push(sample); sampleKeys.add(key); }
    }
  }
  const manifest = {
    schemaVersion: 1, version: `${generatedAt.replace(/[-:.]/g, '')}-${sha256.slice(0, 12)}`, generatedAt,
    source: { path: `sources/${sha256}.js`, sha256, sha1: digest(script, 'sha1'), bytes: Buffer.byteLength(script) },
    capabilities,
    verification: { ...(covered.size === 1 ? { platform: [...covered][0] } : {}), platforms: Object.keys(capabilities), quality: '128k', samples, check: 'musicUrl + HTTP GET audio magic', testedAt: generatedAt },
    upstreams: selected.map(({ item }) => ({ repository: item.repository, commit: item.commit, path: item.path, sha256: digest(item.rawCode), updatedAt: item.updatedAt })),
  };
  return { manifest, script, report };
}

function writeOutput(outputDirectory, result) {
  fs.mkdirSync(outputDirectory, { recursive: true });
  const pending = path.join(outputDirectory, 'manifest.json');
  if (fs.existsSync(pending)) fs.unlinkSync(pending);
  if (!result) return false;
  fs.mkdirSync(path.join(outputDirectory, 'sources'), { recursive: true });
  fs.writeFileSync(path.join(outputDirectory, result.manifest.source.path), result.script);
  fs.writeFileSync(pending, JSON.stringify(result.manifest, null, 2) + '\n');
  return true;
}

module.exports = { MAX_CANDIDATES, PLATFORMS, digest, selectNewestUnique, audioVerified, normalizeVerifiedReports, capabilitiesFor, sanitizeDiagnostics, preliminaryBundle, compileVerified, writeOutput };
