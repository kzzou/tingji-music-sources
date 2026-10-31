'use strict';
const net = require('node:net');
const dns = require('node:dns/promises');
const http = require('node:http');
const https = require('node:https');
const zlib = require('node:zlib');
function publicAddress(address) {
  const value = address.toLowerCase().replace(/^\[|\]$/g, '');
  const type = net.isIP(value);
  if (type === 4) {
    const p = value.split('.').map(Number);
    return !(p[0] === 0 || p[0] === 10 || p[0] === 127 || p[0] >= 224
      || p[0] === 100 && p[1] >= 64 && p[1] <= 127
      || p[0] === 169 && p[1] === 254 || p[0] === 172 && p[1] >= 16 && p[1] <= 31
      || p[0] === 192 && (p[1] === 168 || p[1] === 0 || p[1] === 88 && p[2] === 99)
      || p[0] === 198 && (p[1] === 18 || p[1] === 19 || p[1] === 51 && p[2] === 100)
      || p[0] === 203 && p[1] === 0 && p[2] === 113);
  }
  // Only global-unicast IPv6, excluding protocol transition/special-use blocks.
  if (type !== 6 || !/^[23]/.test(value) || /^2002:/i.test(value) || /^3fff:/i.test(value)) return false;
  const words = value.split(':');
  if (words[0] === '2001' && (parseInt(words[1] || '0', 16) <= 0x1ff || words[1] === 'db8')) return false;
  return true;
}
function safeURL(input) {
  const url = new URL(input);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hostname === 'localhost'
    || (net.isIP(host) ? !publicAddress(host) : !url.hostname.includes('.'))) throw Error('non-public URL blocked');
  return url;
}
async function resolvePublic(url, lookup = dns.lookup) {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (!publicAddress(host)) throw Error('non-public URL blocked');
    return { address: host, family: net.isIP(host) };
  }
  const addresses = await lookup(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(value => !publicAddress(value.address))) throw Error('non-public DNS address blocked');
  return addresses.find(value => value.family === 4) || addresses[0];
}

async function requestPrefix(input, options = {}, dependencies = {}) {
  const url = safeURL(input);
  const signal = options.signal;
  if (signal?.aborted) throw Error('request aborted');
  const resolved = await new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(Error('request aborted')); };
    const cleanup = () => signal?.removeEventListener('abort', abort);
    signal?.addEventListener('abort', abort, { once: true });
    resolvePublic(url, dependencies.lookup).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
  if (signal?.aborted) throw Error('request aborted');
  const limit = options.limit ?? 262144;
  if (!Number.isInteger(limit) || limit < 1 || limit > 262144) throw Error('invalid response limit');
  const method = String(options.method || 'GET').toUpperCase();
  const request = dependencies.request || (url.protocol === 'https:' ? https.request : http.request);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const headers = Object.fromEntries(Object.entries(options.headers || {}).filter(([name]) => name.toLowerCase() !== 'host'));
  headers.Host = url.host;
  // The socket resolver returns only the already validated IP. It never performs
  // a second DNS lookup; TLS and HTTP still identify the original URL hostname.
  const pinnedLookup = (_name, lookupOptions, callback) => {
    if (typeof lookupOptions === 'function') { callback = lookupOptions; lookupOptions = {}; }
    if (lookupOptions?.all) callback(null, [resolved]);
    else callback(null, resolved.address, resolved.family);
  };
  return new Promise((resolve, reject) => {
    let done = false;
    let response;
    let stream;
    let req;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      signal?.removeEventListener('abort', abort);
      if (stream && stream !== response) stream.destroy();
      response?.destroy();
      req?.destroy();
      if (error) reject(error); else resolve(value);
    };
    const abort = () => finish(Error('request aborted'));
    try {
      req = request(url, {
        method, headers, lookup: pinnedLookup,
        servername: net.isIP(host) ? undefined : host,
        agent: false, maxHeaderSize: 32768,
      }, incoming => {
        response = incoming;
        const result = {
          statusCode: incoming.statusCode, statusMessage: incoming.statusMessage,
          headers: incoming.headers, url: url.href, ok: incoming.statusCode >= 200 && incoming.statusCode < 300,
        };
        // Redirect bodies are unnecessary; the caller validates the next target.
        if ([301, 302, 303, 307, 308].includes(incoming.statusCode) && incoming.headers.location) return finish(null, { ...result, bytes: Buffer.alloc(0) });
        const encoding = String(incoming.headers['content-encoding'] || '').trim().toLowerCase();
        if (encoding && encoding !== 'identity' && !['gzip', 'deflate', 'br'].includes(encoding)) return finish(Error('unsupported content encoding'));
        stream = encoding === 'gzip' ? zlib.createGunzip() : encoding === 'deflate' ? zlib.createInflate() : encoding === 'br' ? zlib.createBrotliDecompress() : incoming;
        incoming.on('error', error => finish(error));
        incoming.on('aborted', () => finish(Error('response aborted')));
        stream.on('error', error => finish(error));
        const parts = [];
        let size = 0;
        stream.on('data', chunk => {
          if (done) return;
          const part = Buffer.from(chunk).subarray(0, limit - size);
          parts.push(part);
          size += part.length;
          if (size >= limit) finish(null, { ...result, bytes: Buffer.concat(parts) });
        });
        stream.on('end', () => finish(null, { ...result, bytes: Buffer.concat(parts) }));
        if (stream !== incoming) incoming.pipe(stream);
      });
      req.on('error', error => finish(error));
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) return abort();
      if (options.body != null && method !== 'GET' && method !== 'HEAD') req.write(options.body);
      req.end();
    } catch (error) { finish(error); }
  });
}
module.exports = { publicAddress, safeURL, resolvePublic, requestPrefix };
