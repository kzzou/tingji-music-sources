'use strict';
const net = require('node:net');
const dns = require('node:dns/promises');
function publicAddress(address) {
  const value = address.toLowerCase().replace(/^\[|\]$/g, '');
  const type = net.isIP(value);
  if (type === 4) {
    const p = value.split('.').map(Number);
    return !(p[0] === 0 || p[0] === 10 || p[0] === 127 || p[0] >= 224
      || p[0] === 169 && p[1] === 254 || p[0] === 172 && p[1] >= 16 && p[1] <= 31
      || p[0] === 192 && (p[1] === 168 || p[1] === 0) || p[0] === 198 && (p[1] === 18 || p[1] === 19));
  }
  return type === 6 && !/^(?:::|fc|fd|fe[89ab]|ff)/i.test(value);
}
function safeURL(input) {
  const url = new URL(input);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hostname === 'localhost'
    || (net.isIP(host) ? !publicAddress(host) : !url.hostname.includes('.'))) throw Error('non-public URL blocked');
  return url;
}
async function checkDNS(url) {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) return;
  const addresses = await dns.lookup(host, { all: true });
  if (!addresses.length || addresses.some(value => !publicAddress(value.address))) throw Error('non-public DNS address blocked');
}
module.exports = { publicAddress, safeURL, checkDNS };
