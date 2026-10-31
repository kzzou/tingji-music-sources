'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { digest } = require('../lib/publisher.cjs');
const { DEFAULT_LIMITS, SEARCH_QUERIES, createGitHubClient, sourcePaths, isLXSource, mergeRepositories, selectDiverseNewest, discover } = require('../lib/discovery.cjs');
const source = name => `/*!\n * @name ${name}\n * @author Original author\n */\nconst { on, send, EVENT_NAMES } = globalThis.lx;on(EVENT_NAMES.request,async()=>null);send(EVENT_NAMES.inited,{sources:{}});`;
const file = (path, extra = {}) => ({ path, type: 'blob', mode: '100644', size: 512, ...extra });

function github(repositories, { searchResults = [], badBlob = false } = {}) {
  const calls = [];
  const fetch = async (input, options) => {
    const url = new URL(input); calls.push({ url, options });
    const respond = value => new Response(typeof value === 'string' ? value : JSON.stringify(value), { status: 200 });
    if (url.pathname === '/search/repositories') return respond({ items: searchResults });
    if (url.hostname === 'raw.githubusercontent.com') {
      const [, owner, repo, , ...pieces] = url.pathname.split('/');
      const contents = repositories[`${owner}/${repo}`].files[decodeURIComponent(pieces.join('/'))];
      return respond(contents);
    }
    const match = /^\/repos\/([^/]+\/[^/]+)(.*)$/.exec(url.pathname);
    if (!match || !repositories[match[1]]) return new Response('{}', { status: 404 });
    const repo = repositories[match[1]];
    const commit = repo.commit || 'a'.repeat(40);
    const tail = match[2];
    if (!tail) return respond({ default_branch: 'main', fork: !!repo.fork, archived: !!repo.archived });
    if (tail === '/commits/main') return respond({ sha: commit });
    if (tail.startsWith('/git/trees/')) return respond({ tree: Object.entries(repo.files).map(([name, raw]) => file(name, { size: Buffer.byteLength(raw), sha: badBlob ? 'f'.repeat(40) : digest(`blob ${Buffer.byteLength(raw)}\0${raw}`, 'sha1') })) });
    if (tail === '/commits') return respond([{ commit: { committer: { date: repo.updatedAt || '2026-10-30T00:00:00Z' } } }]);
    return new Response('{}', { status: 404 });
  };
  return { fetch, calls };
}

test('multiple searches include forks, Chinese and English queries, and round-robin repository merge', () => {
  assert.ok(SEARCH_QUERIES.length >= 5);
  assert.ok(SEARCH_QUERIES.every(query => query.q.includes('fork:true')));
  assert.ok(SEARCH_QUERIES.some(query => query.q.includes('洛雪')));
  const merged = mergeRepositories(['seed/main'], [[{ full_name: 'query/a' }, { full_name: 'query/a2' }], [{ full_name: 'other/b' }, { full_name: 'other/b2' }]], [], 4);
  assert.deepEqual(merged, ['seed/main', 'query/a', 'other/b', 'query/a2']);
});

test('token is sent only to GitHub API and redirects are disabled on both hosts', async () => {
  const calls = [];
  const get = createGitHubClient({ token: 'test-secret', fetch: async (url, options) => { calls.push({ url, options }); return new Response('ok'); } });
  await get('https://api.github.com/repos/author/source');
  await get('https://raw.githubusercontent.com/author/source/main/latest.js');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test-secret');
  assert.equal(calls[1].options.headers.Authorization, undefined);
  assert.ok(calls.every(call => call.options.redirect === 'error' && call.options.credentials === 'omit'));
  await assert.rejects(get('https://api.github.com.evil.example/data'), /Unsupported/);
  await assert.rejects(get('https://api.github.com:8443/data'), /Unsupported/);
});

test('path selection keeps nested and distinct sources beside latest while collapsing natural versions', () => {
  const paths = sourcePaths([
    file('family/latest.js'), file('family/1.2.0.js'), file('family/special.js'),
    file('nested/source-v1.9.0.js'), file('nested/source-v1.10.0.js'), file('nested/source-v1.10.0-rc2.js'),
    file('nested/星海音乐源3.2.14.js'), file('nested/星海音乐源4.0.0.js'),
    file('dist/lx-source.min.js'), file('patch-v1.0.js'), file('patch-v1.0.1.js'), file('node_modules/example.js'), file('../escape.js'), file('link.js', { mode: '120000' }), file('history/older.js'),
  ]).map(item => item.path);
  for (const wanted of ['family/latest.js', 'family/special.js', 'nested/source-v1.10.0.js', 'nested/星海音乐源4.0.0.js', 'dist/lx-source.min.js', 'patch-v1.0.1.js']) assert.ok(paths.includes(wanted), wanted);
  for (const rejected of ['family/1.2.0.js', 'nested/source-v1.9.0.js', 'nested/source-v1.10.0-rc2.js', 'nested/星海音乐源3.2.14.js', 'node_modules/example.js', '../escape.js', 'link.js', 'history/older.js']) assert.ok(!paths.includes(rejected), rejected);
});

test('LX static detection accepts destructured API, rejects unrelated or MusicFree code, never executes', () => {
  assert.equal(isLXSource(source('Destructured LX')), true);
  assert.equal(isLXSource('/*! @name MusicFree */\nmodule.exports={platform:"music",search(){}};'), false);
  assert.equal(isLXSource('/*! @name Ordinary script */\nglobalThis.pwned=true;'), false);
  assert.equal(globalThis.pwned, undefined);
  assert.equal(isLXSource(source('bad') + '\nconst = invalid'), false);
});

test('opaque LX-declared or exact previously published bodies remain candidates for runtime checks', () => {
  const declared = '/*!\n * @name Opaque provider\n * @description LX music source\n */\nconst opaque = "encoded payload";';
  assert.equal(isLXSource(declared), true);
  const unknown = '/*!\n * @name Opaque provider\n */\nconst opaque = "encoded payload";';
  assert.equal(isLXSource(unknown), false);
  assert.equal(isLXSource(unknown, { publishedHashMatches: true }), true);
  assert.equal(isLXSource(unknown + '\nconst = invalid', { publishedHashMatches: true }), false);
});

test('dated snapshot and release version folders do not retain older versions of the same family', () => {
  const result = sourcePaths([file('v260108/source-v1.0.0.js'), file('v260114/source-v1.0.1.js'), file('v1.0.0/nested/source.js'), file('v2.0.0/nested/source.js'), file('v260108/other-api.js')]).map(item => item.path);
  assert.ok(result.includes('v260114/source-v1.0.1.js'));
  assert.ok(!result.includes('v260108/source-v1.0.0.js'));
  assert.ok(result.includes('v2.0.0/nested/source.js'));
  assert.ok(!result.includes('v1.0.0/nested/source.js'));
  assert.ok(result.includes('v260108/other-api.js'));
});

test('repository scanning is fair before the static pool limit is reached', async () => {
  const mock = github({ 'seed/large': { files: { 'a.js': source('large1'), 'b.js': source('large2'), 'c.js': source('large3') } }, 'other/small': { files: { 'source.js': source('small') } } });
  const result = await discover({ search: false, repositories: ['seed/large', 'other/small'], fetch: mock.fetch, token: '', limits: { pool: 2, candidates: 2 } });
  assert.equal(result.length, 2);
  assert.deepEqual(new Set(result.map(item => item.repository)), new Set(['seed/large', 'other/small']));
  assert.ok(result.every(item => /^[a-f0-9]{40}$/.test(item.commit) && /^[a-f0-9]{64}$/.test(item.sha256)));
});

test('cross-repository duplicate content does not consume pool capacity and forks remain eligible', async () => {
  const same = source('same');
  const mock = github({ 'seed/main': { files: { 'a.js': same, 'b.js': source('unique') } }, 'fork/main': { fork: true, files: { 'a.js': same, 'b.js': source('fork-specific') } } });
  let summary;
  const result = await discover({ search: false, repositories: ['seed/main', 'fork/main'], fetch: mock.fetch, token: '', onSummary: value => { summary = value; } });
  assert.equal(result.length, 3);
  assert.equal(new Set(result.map(item => item.sha256)).size, 3);
  assert.ok(result.some(item => item.repository === 'fork/main'));
  assert.equal(summary.duplicates, 1);
});

test('repository, file-attempt and byte budgets cap discovery rather than unbounded downloading', async () => {
  const mock = github({ 'seed/main': { files: { 'a.js': source('a'), 'b.js': source('b') } }, 'other/main': { files: { 'source.js': source('other') } } });
  let summary;
  const result = await discover({ search: false, repositories: ['seed/main', 'other/main'], fetch: mock.fetch, token: '', limits: { repositories: 1, attempts: 1, bytes: 1024 }, onSummary: value => { summary = value; } });
  assert.equal(result.length, 1);
  assert.equal(summary.inspectedFiles, 1);
  assert.equal(summary.repositories.length, 1);
  assert.ok(summary.downloadedBytes <= 1024);
  await assert.rejects(discover({ search: false, repositories: [], limits: { pool: DEFAULT_LIMITS.pool + 1 } }), /Invalid discovery limit/);
});

test('Git blob mismatch rejects a file even if it looks like valid LX code', async () => {
  const mock = github({ 'seed/main': { files: { 'source.js': source('a') } } }, { badBlob: true });
  const result = await discover({ search: false, repositories: ['seed/main'], fetch: mock.fetch, token: '' });
  assert.equal(result.length, 0);
});

test('current published fixed-commit provider is reserved alongside diverse newer candidates', async () => {
  const old = source('old-good');
  const mock = github({ 'seed/old': { files: { 'source.js': old }, updatedAt: '2025-01-01T00:00:00Z' }, 'other/new': { files: { 'source.js': source('new') } } });
  const retained = [{ repository: 'seed/old', commit: 'a'.repeat(40), path: 'source.js', sha256: digest(old), updatedAt: '2025-01-01T00:00:00Z' }];
  const result = await discover({ search: false, repositories: ['other/new'], retained, fetch: mock.fetch, token: '', limits: { candidates: 2 } });
  assert.equal(result[0].retained, true);
  assert.equal(result[0].sha256, digest(old));
  assert.equal(result[1].repository, 'other/new');
});

test('final selection includes multiple repositories rather than only a recently bulk-updated collection', () => {
  const pool = Array.from({ length: 50 }, (_, index) => ({ repository: 'large/repo', path: `${index}.js`, updatedAt: '2026-10-30T00:00:00Z', rawCode: source(`large${index}`) }));
  pool.push({ repository: 'small/repo', path: 'source.js', updatedAt: '2026-09-01T00:00:00Z', rawCode: source('small') });
  const result = selectDiverseNewest(pool, 30);
  assert.equal(result.length, 30);
  assert.ok(result.some(item => item.repository === 'small/repo'));
});
