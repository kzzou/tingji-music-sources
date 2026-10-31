'use strict';
const { selectNewestUnique, digest } = require('./publisher.cjs');
const { inspectSources } = require('./generator.cjs');
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_POOL = 32;

async function get(url, limit = 4 * 1024 * 1024) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !['api.github.com', 'raw.githubusercontent.com'].includes(parsed.hostname)) throw Error('Unsupported discovery host');
  const response = await fetch(parsed, { redirect: 'error', credentials: 'omit', headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Tingji-Music-Sources' }, signal: AbortSignal.timeout(15000) });
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
}
const json = async url => JSON.parse(await get(url));
const validRepository = value => /^[\w.-]+\/[\w.-]+$/.test(value);

function sourcePaths(tree) {
  const files = tree.filter(item => item.type === 'blob' && item.mode !== '120000' && item.path.endsWith('.js')
    && item.size > 0 && item.size <= MAX_FILE_BYTES
    && !/(^|\/)(node_modules|dist|build|\.git)(\/|$)/.test(item.path)
    && !item.path.split('/').some(part => part === '..'));
  const latest = files.filter(item => /(^|\/)latest\.js$/i.test(item.path));
  // Repositories without latest.js may expose one source at the root.
  return latest.length ? latest : files.filter(item => !item.path.includes('/')).slice(0, 4);
}

async function discover({ report = () => {}, search = true } = {}) {
  const repositories = ['pdone/lx-music-source'];
  if (search) {
    try {
      const result = await json('https://api.github.com/search/repositories?q=lx-music-source+in:name,description+fork:false+archived:false&sort=updated&order=desc&per_page=6');
      for (const repo of result.items || []) {
        if (validRepository(repo.full_name) && repo.full_name !== 'kzzou/tingji-music-sources' && !repositories.includes(repo.full_name)) repositories.push(repo.full_name);
        if (repositories.length === 4) break;
      }
    } catch (error) { report({ stage: 'search', error: error.message }); }
  }
  const pool = [];
  for (const repository of repositories) {
    try {
      const base = `https://api.github.com/repos/${repository}`;
      const metadata = await json(base);
      const commit = await json(`${base}/commits/${encodeURIComponent(metadata.default_branch)}`);
      if (!/^[a-f0-9]{40}$/.test(commit.sha)) throw Error('Invalid repository revision');
      const listing = await json(`${base}/git/trees/${commit.sha}?recursive=1`);
      if (listing.truncated || !Array.isArray(listing.tree)) throw Error('Incomplete repository tree');
      for (const entry of sourcePaths(listing.tree)) {
        if (pool.length >= MAX_POOL) break;
        try {
          const encoded = entry.path.split('/').map(encodeURIComponent).join('/');
          const history = await json(`${base}/commits?sha=${commit.sha}&path=${encodeURIComponent(entry.path)}&per_page=1`);
          const updatedAt = history[0]?.commit?.committer?.date;
          if (!updatedAt || !Number.isFinite(Date.parse(updatedAt))) throw Error('Missing source commit date');
          const rawCode = await get(`https://raw.githubusercontent.com/${repository}/${commit.sha}/${encoded}`, MAX_FILE_BYTES);
          if (digest(`blob ${Buffer.byteLength(rawCode)}\0${rawCode}`, 'sha1') !== entry.sha) throw Error('Git blob hash mismatch');
          if (!inspectSources([{ rawCode, path: entry.path }]).sources.length) throw Error('Not a valid LX source script');
          pool.push({ repository, commit: commit.sha, path: entry.path, updatedAt, rawCode });
          report({ stage: 'discovery', repository, path: entry.path, updatedAt });
        } catch (error) { report({ stage: 'candidate', repository, path: entry.path, error: error.message }); }
      }
    } catch (error) { report({ stage: 'repository', repository, error: error.message }); }
  }
  return selectNewestUnique(pool);
}
module.exports = { get, sourcePaths, discover };
