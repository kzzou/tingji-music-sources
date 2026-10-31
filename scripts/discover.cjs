#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { discover } = require('../lib/discovery.cjs');
const root = path.resolve(__dirname, '..');

async function main() {
  const directory = path.resolve(process.env.TINGJI_DISCOVERY_DIR || path.join(root, 'discovery'));
  const previousPath = path.join(root, 'manifest.json');
  let retained = [];
  if (fs.existsSync(previousPath)) {
    const previous = JSON.parse(fs.readFileSync(previousPath, 'utf8'));
    if (previous.schemaVersion === 1 && Array.isArray(previous.upstreams)) retained = previous.upstreams;
  }
  const events = [];
  let summary;
  const sources = await discover({ retained, search: !process.argv.includes('--seed-only'), report: item => events.push(item), onSummary: item => { summary = item; } });
  fs.mkdirSync(path.join(directory, 'scripts'), { recursive: true });
  const candidates = sources.map(({ rawCode, ...item }) => {
    const file = `scripts/${item.sha256}.js`;
    fs.writeFileSync(path.join(directory, file), rawCode);
    return { ...item, file };
  });
  const catalog = { schemaVersion: 1, discoveredAt: new Date().toISOString(), candidates, summary };
  fs.writeFileSync(path.join(directory, 'catalog.json'), JSON.stringify(catalog, null, 2) + '\n');
  fs.writeFileSync(path.join(directory, 'diagnostics.json'), JSON.stringify({ ...catalog, events }, null, 2) + '\n');
  console.log(`Discovered ${candidates.length} distinct LX candidates from ${new Set(candidates.map(item => item.repository)).size} repositories; scanned ${summary.inspectedFiles} files, ${summary.uniqueSources} unique static sources. No downloaded code executed.`);
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
