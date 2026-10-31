'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const zlib = require('node:zlib');
const { publicAddress, safeURL, resolvePublic, requestPrefix } = require('../lib/network.cjs');

function responder({ bytes = Buffer.from('response'), encoding, statusCode = 200, headers = {}, inspect = () => {} } = {}) {
  return (url, options, callback) => {
    const req = new EventEmitter();
    req.destroy = () => {};
    req.write = () => {};
    req.end = () => queueMicrotask(() => {
      const incoming = new PassThrough();
      incoming.statusCode = statusCode;
      incoming.statusMessage = 'OK';
      incoming.headers = { ...headers, ...(encoding ? { 'content-encoding': encoding } : {}) };
      inspect(url, options);
      callback(incoming);
      incoming.end(bytes);
    });
    return req;
  };
}

test('request socket uses one vetted DNS answer with original HTTP Host and TLS servername', async () => {
  let dnsCalls = 0;
  let socketAddress;
  const lookup = async () => {
    dnsCalls++;
    return [{ address: dnsCalls === 1 ? '8.8.8.8' : '127.0.0.1', family: 4 }];
  };
  const result = await requestPrefix('https://music.example:8443/song', { headers: { host: 'attacker.invalid' } }, {
    lookup,
    request: responder({ inspect(url, options) {
      assert.equal(url.hostname, 'music.example');
      assert.equal(options.headers.Host, 'music.example:8443');
      assert.equal(options.servername, 'music.example');
      assert.equal(options.agent, false);
      options.lookup('music.example', {}, (error, address, family) => {
        assert.equal(error, null); socketAddress = address; assert.equal(family, 4);
      });
      options.lookup('music.example', { all: true }, (error, addresses) => {
        assert.equal(error, null); assert.deepEqual(addresses, [{ address: '8.8.8.8', family: 4 }]);
      });
    } }),
  });
  assert.equal(dnsCalls, 1);
  assert.equal(socketAddress, '8.8.8.8');
  assert.equal(result.bytes.toString(), 'response');
});

test('private or mixed DNS answers fail before creating a socket', async () => {
  for (const addresses of [[{ address: '127.0.0.1', family: 4 }], [{ address: '8.8.8.8', family: 4 }, { address: '100.100.100.200', family: 4 }]]) {
    let requests = 0;
    await assert.rejects(requestPrefix('https://music.example/song', {}, { lookup: async () => addresses, request() { requests++; } }), /non-public DNS/);
    assert.equal(requests, 0);
  }
});

test('redirect response is returned without following or consuming its body; new target must be checked', async () => {
  const result = await requestPrefix('https://music.example/song', {}, { lookup: async () => [{ address: '8.8.8.8', family: 4 }], request: responder({ statusCode: 302, headers: { location: 'http://169.254.169.254/meta' } }) });
  assert.equal(result.statusCode, 302);
  assert.equal(result.bytes.length, 0);
  assert.throws(() => safeURL(new URL(result.headers.location, result.url)), /non-public/);
  await assert.rejects(resolvePublic(safeURL('https://new-target.example/song'), async () => [{ address: '192.168.0.1', family: 4 }]), /non-public DNS/);
});

test('bounded prefix applies after gzip/deflate/br decoding', async () => {
  const plain = Buffer.alloc(1024, 'a');
  for (const [encoding, compress] of [['gzip', zlib.gzipSync], ['deflate', zlib.deflateSync], ['br', zlib.brotliCompressSync]]) {
    const result = await requestPrefix('https://music.example/song', { limit: 32 }, { lookup: async () => [{ address: '8.8.8.8', family: 4 }], request: responder({ bytes: compress(plain), encoding }) });
    assert.equal(result.bytes.length, 32);
    assert.equal(result.bytes.toString(), 'a'.repeat(32));
  }
});

test('abort signal destroys an outstanding request and rejects promptly', async () => {
  const controller = new AbortController();
  let destroyed = false;
  const result = requestPrefix('https://music.example/song', { signal: controller.signal }, {
    lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    request() { const req = new EventEmitter(); req.destroy = () => { destroyed = true; }; req.end = () => controller.abort(); return req; },
  });
  await assert.rejects(result, /request aborted/);
  assert.equal(destroyed, true);
});

test('abort signal also stops waiting for DNS before any socket exists', async () => {
  const controller = new AbortController();
  let requested = false;
  const result = requestPrefix('https://music.example/song', { signal: controller.signal }, {
    lookup: () => new Promise(() => {}), request() { requested = true; },
  });
  controller.abort();
  await assert.rejects(result, /request aborted/);
  assert.equal(requested, false);
});

test('rejects CGNAT, documentation, transition, benchmark, multicast and IPv6 mapped private addresses', () => {
  for (const address of ['100.64.0.1', '100.127.255.254', '100.100.100.200', '192.0.2.1', '192.88.99.1', '198.18.0.1', '198.19.255.255', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255', '::ffff:127.0.0.1', '::ffff:c0a8:1', '2001:db8::1', '2001:0db8:0:0:0:0:0:1', '2001:2::1', '2002:c0a8:1::1', 'ff02::1']) assert.equal(publicAddress(address), false, address);
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888']) assert.equal(publicAddress(address), true, address);
});
