'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { digest } = require('./publisher.cjs');
const { inspectSources } = require('./generator.cjs');
const DEFAULT_LIMITS = Object.freeze({ repositories: 20, pool: 100, candidates: 30, bytes: 32 * 1024 * 1024, fileBytes: 1024 * 1024, attempts: 200, pathsPerRepository: 40 });
const SEARCH_QUERIES = Object.freeze([
  { q: 'lx-music-source in:name,description fork:true archived:false', sort: 'updated' },
  { q: '洛雪 音源 in:name,description,readme fork:true archived:false', sort: 'stars' },
  { q: 'lx music source in:name,description fork:true archived:false', sort: 'updated' },
  { q: '洛雪音源 in:readme fork:true archived:false', sort: 'updated' },
  { q: 'LX Music 音源 in:readme fork:true archived:false', sort: 'stars' },
]);
const validRepository = value => typeof value === 'string' && /^[\w.-]+\/[\w.-]+$/.test(value);
const validPath = value => typeof value === 'string' && value.length <= 500 && !value.startsWith('/') && !value.includes('\\') && !value.split('/').some(part => !part || part === '..' || part === '.');
const encodedPath = value => value.split('/').map(encodeURIComponent).join('/');
const natural = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const compareDates = (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || `${a.repository}/${a.path}`.localeCompare(`${b.repository}/${b.path}`);

function createGitHubClient({ fetch: fetcher = globalThis.fetch, token = process.env.GH_TOKEN } = {}) {
  return async function get(url, limit = 4 * 1024 * 1024) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port && parsed.port !== '443' || !['api.github.com', 'raw.githubusercontent.com'].includes(parsed.hostname)) throw Error('Unsupported discovery host');
    const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'Tingji-Music-Sources' };
    if (parsed.hostname === 'api.github.com' && token) headers.Authorization = `Bearer ${token}`;
    const response = await fetcher(parsed, { redirect: 'error', credentials: 'omit', headers, signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw Error(`GitHub HTTP ${response.status}`);
    if (Number(response.headers.get('content-length')) > limit) throw Error('GitHub response exceeds limit');
    const reader = response.body.getReader();
    const parts = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > limit) throw Error('GitHub response exceeds limit');
        parts.push(Buffer.from(value));
      }
    } finally { await reader.cancel().catch(() => {}); }
    return Buffer.concat(parts).toString('utf8');
  };
}
const get = (...args) => createGitHubClient()(...args);

function sourcePaths(tree, maximum = DEFAULT_LIMITS.pathsPerRepository) {
  const files = tree.filter(item => item.type === 'blob' && item.mode !== '120000' && validPath(item.path) && /\.js$/i.test(item.path)
    && item.size > 0 && item.size <= DEFAULT_LIMITS.fileBytes
    && !/(^|\/)(node_modules|vendor|\.git|\.github|__tests__|tests?|fixtures?|coverage|archive|archives|history|old|backup|历史|旧版)(\/|$)/i.test(item.path)
    && !/\.(?:test|spec)\.js$/i.test(item.path));
  const aliases = new Set(files.filter(item => /(^|\/)(?:latest|release|current)\.js$/i.test(item.path)).map(item => path.posix.dirname(item.path)));
  const families = new Map();
  for (const item of files) {
    const directory = path.posix.dirname(item.path);
    const familyDirectory = directory.split('/').filter(part => !/^v?(?:\d{6,8}|\d+(?:\.\d+){1,3})$/i.test(part)).join('/');
    const name = path.posix.basename(item.path, path.posix.extname(item.path));
    const version = /v?(\d+(?:\.\d+){1,3})(?:[-_.]?(alpha|beta|rc)(\d*))?$/i.exec(name);
    const numericOnly = /^v?\d+(?:\.\d+){1,3}$/i.test(name);
    if (numericOnly && aliases.has(directory)) continue;
    const family = version ? name.slice(0, version.index).replace(/[-_ .vV]+$/g, '').toLowerCase() : name.toLowerCase();
    const key = `${familyDirectory}/${family || '$version'}`;
    const prior = families.get(key);
    const parts = version ? version[1].split('.').map(Number) : [];
    const rank = version?.[2] ? { alpha: 0, beta: 1, rc: 2 }[version[2].toLowerCase()] : 3;
    const compare = prior ? [0, 1, 2, 3].reduce((result, index) => result || (parts[index] || 0) - (prior.parts[index] || 0), 0) || rank - prior.rank || natural.compare(item.path, prior.item.path) : 1;
    if (!prior || compare > 0) families.set(key, { item, parts, rank });
  }
  const priority = value => /(^|\/)(?:latest|release|current)\.js$/i.test(value) ? 0 : /source|音源|lx|api/i.test(value) ? 1 : 2;
  return [...families.values()].map(value => value.item).sort((a, b) => priority(a.path) - priority(b.path) || a.path.split('/').length - b.path.split('/').length || natural.compare(a.path, b.path)).slice(0, maximum);
}

function isLXSource(rawCode, { publishedHashMatches = false } = {}) {
  const header = /^\uFEFF?\s*\/\*[\s\S]*?\*\//.exec(rawCode)?.[0] || '';
  const body = rawCode.slice(header.length);
  // Static recognition does not establish compatibility. Explicit LX metadata
  // and previously published exact hashes may admit opaque bodies for runtime
  // validation; no obfuscation or authorization code is rewritten.
  const visibleAPI = /\blx\b/.test(body) && /EVENT_NAMES|currentScriptInfo|\b(?:musicUrl|inited)\b/.test(body);
  const declaredLX = /@(?:name|description|homepage)[^\r\n]*(?:\blx\b|lx[-_ ]?music|洛雪|落雪)/i.test(header);
  return (visibleAPI || declaredLX || publishedHashMatches) && inspectSources([{ rawCode }]).sources.length === 1;
}

function mergeRepositories(seeds, searches, retained = [], maximum = DEFAULT_LIMITS.repositories) {
  const result = [];
  const add = value => { if (validRepository(value) && value !== 'kzzou/tingji-music-sources' && !result.includes(value) && result.length < maximum) result.push(value); };
  retained.forEach(item => add(item.repository));
  seeds.forEach(item => add(typeof item === 'string' ? item : item.repository));
  const width = Math.max(0, ...searches.map(list => list.length));
  for (let index = 0; index < width && result.length < maximum; index++) for (const list of searches) add(list[index]?.full_name);
  return result;
}

function selectDiverseNewest(pool, maximum = DEFAULT_LIMITS.candidates) {
  const result = [];
  const seen = new Set();
  const add = item => { const hash = item.sha256 || digest(item.rawCode); if (seen.has(hash) || result.length >= maximum) return; seen.add(hash); result.push({ ...item, sha256: hash }); };
  pool.filter(item => item.retained).sort(compareDates).slice(0, 6).forEach(add);
  const groups = new Map();
  for (const item of [...pool].sort(compareDates)) {
    const list = groups.get(item.repository) || [];
    list.push(item); groups.set(item.repository, list);
  }
  const queues = [...groups.values()];
  for (let round = 0; result.length < maximum && queues.some(list => list.length > round); round++) for (const list of queues) if (list[round]) add(list[round]);
  return result;
}

async function mapLimited(values, operation, concurrency = 3) {
  const result = new Array(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    for (;;) { const index = cursor++; if (index >= values.length) return; result[index] = await operation(values[index], index); }
  }));
  return result;
}

async function discover({ report = () => {}, search = true, repositories, retained = [], limits: customLimits = {}, fetch: fetcher, token, onSummary = () => {} } = {}) {
  const limits = { ...DEFAULT_LIMITS, ...customLimits };
  for (const key of Object.keys(DEFAULT_LIMITS)) {
    if (!Number.isInteger(limits[key]) || limits[key] < 1 || limits[key] > DEFAULT_LIMITS[key]) throw Error(`Invalid discovery limit: ${key}`);
  }
  const request = createGitHubClient({ fetch: fetcher, token });
  const json = async url => JSON.parse(await request(url));
  const seeds = repositories || JSON.parse(fs.readFileSync(path.join(__dirname, '../config/repositories.json'), 'utf8')).repositories;
  const searches = [];
  if (search) for (const query of SEARCH_QUERIES) {
    try {
      const params = new URLSearchParams({ q: query.q, sort: query.sort, order: 'desc', per_page: '15' });
      const found = await json(`https://api.github.com/search/repositories?${params}`);
      searches.push((found.items || []).filter(item => !item.archived));
      report({ stage: 'search', query: query.q, found: found.items?.length || 0 });
    } catch (error) { report({ stage: 'search', query: query.q, error: error.message }); }
  }
  const chosen = mergeRepositories(seeds, searches, retained, limits.repositories);
  const summary = { searchedQueries: search ? SEARCH_QUERIES.length : 0, repositories: chosen, inspectedFiles: 0, downloadedBytes: 0, uniqueSources: 0, duplicates: 0, rejected: 0, retained: 0, selected: 0 };
  const treeCache = new Map();
  const loadTree = async (repository, commit) => {
    const key = `${repository}@${commit}`;
    if (!treeCache.has(key)) treeCache.set(key, (async () => {
      const listing = await json(`https://api.github.com/repos/${repository}/git/trees/${commit}?recursive=1`);
      if (listing.truncated || !Array.isArray(listing.tree)) throw Error('Incomplete repository tree');
      return listing.tree;
    })());
    return treeCache.get(key);
  };
  const contexts = (await mapLimited(chosen, async repository => {
    try {
      const base = `https://api.github.com/repos/${repository}`;
      const metadata = await json(base);
      if (metadata.archived) throw Error('Archived repository');
      const commit = await json(`${base}/commits/${encodeURIComponent(metadata.default_branch)}`);
      if (!/^[a-f0-9]{40}$/.test(commit.sha)) throw Error('Invalid repository revision');
      const tree = await loadTree(repository, commit.sha);
      const entries = sourcePaths(tree, limits.pathsPerRepository);
      report({ stage: 'repository', repository, files: entries.length, fork: metadata.fork === true });
      return { repository, commit: commit.sha, entries };
    } catch (error) { report({ stage: 'repository', repository, error: error.message }); return null; }
  })).filter(Boolean);
  const pool = [];
  const hashes = new Map();
  const pendingHashes = new Set();
  let reservedBytes = 0;
  const inspectEntry = async ({ repository, commit, entry, retained: isRetained, expectedHash, updatedAt }) => {
    if (summary.inspectedFiles >= limits.attempts || pool.length >= limits.pool || reservedBytes + entry.size > limits.bytes) return null;
    reservedBytes += entry.size;
    summary.inspectedFiles++;
    try {
      const rawCode = await request(`https://raw.githubusercontent.com/${repository}/${commit}/${encodedPath(entry.path)}`, limits.fileBytes);
      const bytes = Buffer.byteLength(rawCode);
      summary.downloadedBytes += bytes;
      if (bytes !== entry.size || digest(`blob ${bytes}\0${rawCode}`, 'sha1') !== entry.sha) throw Error('Git blob hash mismatch');
      const sha256 = digest(rawCode);
      if (expectedHash && expectedHash !== sha256) throw Error('Retained source hash mismatch');
      if (!isLXSource(rawCode, { publishedHashMatches: !!isRetained && expectedHash === sha256 })) throw Error('Not an LX source script');
      if (hashes.has(sha256) || pendingHashes.has(sha256)) {
        summary.duplicates++;
        if (isRetained && hashes.has(sha256)) hashes.get(sha256).retained = true;
        return null;
      }
      pendingHashes.add(sha256);
      try {
        if (!updatedAt || !Number.isFinite(Date.parse(updatedAt))) {
          const history = await json(`https://api.github.com/repos/${repository}/commits?sha=${commit}&path=${encodeURIComponent(entry.path)}&per_page=1`);
          updatedAt = history[0]?.commit?.committer?.date;
        }
        if (!updatedAt || !Number.isFinite(Date.parse(updatedAt))) throw Error('Missing source commit date');
        if (pool.length >= limits.pool) return null;
        const item = { repository, commit, path: entry.path, updatedAt, sha256, bytes, rawCode, ...(isRetained ? { retained: true } : {}) };
        hashes.set(sha256, item); pool.push(item);
        report({ stage: 'discovery', repository, path: entry.path, updatedAt, retained: !!isRetained });
        return item;
      } finally { pendingHashes.delete(sha256); }
    } catch (error) { summary.rejected++; report({ stage: 'candidate', repository, path: entry.path, error: error.message }); return null; }
  };
  // Fixed-commit prior providers are reserved but revalidated, never assumed good.
  for (const item of retained.slice(0, 6)) {
    if (!validRepository(item.repository) || !/^[a-f0-9]{40}$/.test(item.commit) || !validPath(item.path) || !/^[a-f0-9]{64}$/.test(item.sha256)) continue;
    try {
      const tree = await loadTree(item.repository, item.commit);
      const entry = tree.find(entry => entry.path === item.path && entry.type === 'blob' && entry.mode !== '120000');
      if (entry && entry.size > 0 && entry.size <= limits.fileBytes) await inspectEntry({ ...item, entry, retained: true, expectedHash: item.sha256 });
    } catch (error) { report({ stage: 'retained', repository: item.repository, path: item.path, error: error.message }); }
  }
  for (let round = 0; contexts.some(context => context.entries.length > round) && pool.length < limits.pool && summary.inspectedFiles < limits.attempts; round++) {
    await mapLimited(contexts.filter(context => context.entries[round]), async context => inspectEntry({ ...context, entry: context.entries[round] }));
  }
  const selected = selectDiverseNewest(pool, limits.candidates);
  summary.uniqueSources = pool.length; summary.selected = selected.length; summary.retained = selected.filter(item => item.retained).length;
  onSummary(summary);
  report({ stage: 'summary', ...summary });
  return selected;
}
module.exports = { DEFAULT_LIMITS, SEARCH_QUERIES, get, createGitHubClient, sourcePaths, isLXSource, mergeRepositories, selectDiverseNewest, discover };
