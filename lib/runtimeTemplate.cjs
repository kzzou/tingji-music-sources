"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.aggregateRuntime = void 0;
// This is emitted as source text; it must not depend on Metro's function.toString().
exports.aggregateRuntime = String.raw `(function(host, realGlobal, definitions, options) {
  'use strict';
  const platforms = ['kw', 'kg', 'tx', 'wy', 'mg'];
  const qualities = ['128k', '320k', 'flac', 'flac24bit'];
  const providers = [];
  const sharedGets = new Map();
  const now = () => Date.now();
  const safeError = value => String(value && value.message || value || 'failed').replace(/https?:\/\/[^\s"'<>]+/g, '[URL]').slice(0, 180);
  const normalize = (input, mode) => {
    const copy = JSON.parse(JSON.stringify(input));
    const music = copy.info && copy.info.musicInfo;
    if (!music || !music.meta || mode === 'modern') return copy;
    const meta = music.meta;
    const fields = {songmid:'songId', songId:'id', hash:'hash', albumName:'albumName', albumId:'albumId', img:'picUrl', types:'qualitys', _types:'_qualitys', strMediaMid:'strMediaMid', albumMid:'albumMid', copyrightId:'copyrightId', lrcUrl:'lrcUrl', mrcUrl:'mrcUrl', trcUrl:'trcUrl'};
    for (const key of Object.keys(fields)) {
      if (music[key] == null && Object.prototype.hasOwnProperty.call(meta, fields[key])) music[key] = meta[fields[key]];
    }
    if (mode === 'legacy') {
      delete music.id;
      delete music.meta;
    }
    return copy;
  };
  const finishContext = context => {
    if (!context.active) return;
    context.active = false;
    for (const cancel of Array.from(context.pending)) { try { cancel(); } catch (_) {} }
    for (const timer of context.timers) realGlobal.clearTimeout(timer);
    context.pending.clear();
    context.timers.clear();
  };
  const newContext = () => ({active:true, pending:new Set(), timers:new Set()});
  const sharedRequest = (url, requestOptions, callback) => {
    const method = String(requestOptions.method || 'GET').toUpperCase();
    let key = null;
    if ((method === 'GET' || method === 'HEAD') && !requestOptions.body && !requestOptions.form && !requestOptions.formData) {
      const headers = Object.keys(requestOptions.headers || {}).sort().map(k => [k.toLowerCase(), requestOptions.headers[k]]);
      key = JSON.stringify([url, method, headers, requestOptions.binary === true, requestOptions.timeout]);
    }
    let item = key && sharedGets.get(key);
    if (!item) {
      item = {callbacks:new Set(), done:false, cancel:null};
      if (key) sharedGets.set(key, item);
      item.callbacks.add(callback);
      const complete = (...args) => {
        item.done = true;
        if (key && sharedGets.get(key) === item) sharedGets.delete(key);
        const callbacks = Array.from(item.callbacks);
        item.callbacks.clear();
        for (const fn of callbacks) { try { fn(...args); } catch (_) {} }
      };
      try { item.cancel = host.request(url, requestOptions, complete); }
      catch (error) { complete(error, null, null); }
    } else item.callbacks.add(callback);
    return () => {
      item.callbacks.delete(callback);
      if (!item.done && item.callbacks.size === 0) {
        if (key && sharedGets.get(key) === item) sharedGets.delete(key);
        if (typeof item.cancel === 'function') item.cancel();
      }
    };
  };
  const register = definition => {
    const provider = {definition, handler:null, api:null, capabilities:null, busy:false, health:{}, context:null, boot:newContext()};
    let resolveReady;
    provider.ready = new Promise(resolve => { resolveReady = resolve; });
    let initialized = false;
    const bootTimer = realGlobal.setTimeout(() => {
      if (initialized) return;
      initialized = true;
      finishContext(provider.boot);
      resolveReady();
    }, options.initTimeoutMs);
    const wrappedTimer = (callback, delay, ...args) => {
      const context = provider.context || provider.boot;
      if (!context.active) return -1;
      const timer = realGlobal.setTimeout(() => {
        context.timers.delete(timer);
        if (context.active) callback(...args);
      }, Math.max(0, Number(delay) || 0));
      context.timers.add(timer);
      return timer;
    };
    const wrappedClear = timer => {
      provider.boot.timers.delete(timer);
      if (provider.context) provider.context.timers.delete(timer);
      realGlobal.clearTimeout(timer);
    };
    const localLx = Object.assign({}, host, {
      currentScriptInfo:Object.assign({}, definition.metadata, {rawScript:definition.rawCode}),
      on(event, handler) {
        if (event === host.EVENT_NAMES.request && typeof handler === 'function') provider.handler = handler;
        return Promise.resolve();
      },
      send(event, data) {
        if (event === host.EVENT_NAMES.inited && !initialized) {
          initialized = true;
          realGlobal.clearTimeout(bootTimer);
          if (data && data.status === false) {
            finishContext(provider.boot);
            resolveReady();
            return Promise.resolve();
          }
          const capabilities = {};
          for (const platform of platforms) {
            const entry = data && data.sources && data.sources[platform];
            if (!entry || entry.type !== 'music' || !Array.isArray(entry.actions) || !entry.actions.includes('musicUrl') || !Array.isArray(entry.qualitys)) continue;
            const supported = qualities.filter(q => entry.qualitys.includes(q) && definition.verifiedCapabilities && Array.isArray(definition.verifiedCapabilities[platform]) && definition.verifiedCapabilities[platform].includes(q));
            if (supported.length) capabilities[platform] = {type:'music', actions:['musicUrl'], qualitys:supported};
          }
          provider.capabilities = capabilities;
          resolveReady();
        }
        // Child updates remain represented by provenance; only the aggregate sends native init.
        return Promise.resolve();
      },
      request(url, requestOptions, callback) {
        const context = provider.context || provider.boot;
        if (!context.active) { callback(new Error('request expired'), null, null); return () => {}; }
        let cancel;
        let abort;
        let completed = false;
        const done = (error, response, body) => {
          completed = true;
          if (abort) context.pending.delete(abort);
          if (context.active) callback(error, response, body);
        };
        cancel = sharedRequest(url, requestOptions || {}, done);
        abort = () => {
          if (!completed) { completed = true; cancel(); callback(new Error('request canceled'), null, null); }
          context.pending.delete(abort);
        };
        if (!completed) context.pending.add(abort);
        return abort;
      },
    });
    provider.api = localLx;
    const scope = Object.create(realGlobal);
    Object.defineProperties(scope, {
      lx:{value:localLx}, globalThis:{value:scope}, window:{value:scope}, self:{value:scope},
      setTimeout:{value:wrappedTimer}, clearTimeout:{value:wrappedClear},
    });
    providers.push(provider);
    try { definition.factory.call(scope, scope, localLx, scope, scope, wrappedTimer, wrappedClear); }
    catch (error) {
      initialized = true;
      realGlobal.clearTimeout(bootTimer);
      finishContext(provider.boot);
      provider.capabilities = null;
      resolveReady();
    }
    return provider;
  };
  for (const definition of definitions) register(definition);
  const verify = (url, timeout) => new Promise((resolve, reject) => {
    if (typeof url !== 'string' || url.length > 2048 || !/^https?:\/\/[^\s]+$/i.test(url)) return reject(new Error('invalid media URL'));
    let settled = false;
    let cancel;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      realGlobal.clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const timer = realGlobal.setTimeout(() => {
      if (typeof cancel === 'function') cancel();
      finish(null, 'unknown');
    }, timeout);
    try {
      cancel = host.request(url, {method:'HEAD', timeout}, (error, response) => {
        if (error || !response) return finish(null, 'unknown');
        const status = response.statusCode;
        if (status === 405 || status === 501) return finish(null, 'unknown');
        if (status < 200 || status >= 300) return finish(new Error('media HTTP ' + status));
        const headers = response.headers || {};
        const header = Object.keys(headers).find(key => key.toLowerCase() === 'content-type');
        const type = String(header && headers[header] || '').toLowerCase();
        if (/json|text\/html|application\/xml/.test(type)) return finish(new Error('non-audio response'));
        finish(null, /audio\/|video\/mp4|octet-stream|mpegurl|application\/ogg/.test(type) ? 'valid' : 'unknown');
      });
    } catch (_) { finish(null, 'unknown'); }
  });
  const attempt = (provider, input, timeout) => {
    const context = newContext();
    provider.context = context;
    provider.busy = true;
    const work = Promise.resolve().then(() => provider.handler.call(provider.api, normalize(input, provider.definition.mode)));
    work.then(() => { provider.busy = false; }, () => { provider.busy = false; });
    let timer;
    const limited = new Promise((resolve, reject) => {
      timer = realGlobal.setTimeout(() => reject(new Error('source timeout')), timeout);
      work.then(resolve, reject);
    });
    return limited.finally(() => {
      realGlobal.clearTimeout(timer);
      finishContext(context);
    });
  };
  const route = async (input, deadline) => {
    if (input.action !== 'musicUrl') throw new Error('unsupported action');
    const platform = input.source;
    const quality = input.info && input.info.type;
    const music = input.info && input.info.musicInfo;
    const song = String(music && (music.meta && music.meta.songId || music.songmid || music.id) || 'unknown');
    const candidates = providers.filter(p => p.handler && !p.busy && p.capabilities && p.capabilities[platform] && p.capabilities[platform].qualitys.includes(quality));
    candidates.sort((a, b) => {
      const ac = a.health[platform] && a.health[platform].until > now() ? 1 : 0;
      const bc = b.health[platform] && b.health[platform].until > now() ? 1 : 0;
      const priority = provider => {
        const ranks = provider.definition.platformPriorities;
        return ranks && typeof ranks[platform] === 'number' ? ranks[platform] : provider.definition.priority;
      };
      return ac - bc || priority(a) - priority(b);
    });
    let fallback = null;
    const errors = [];
    const groups = new Set();
    for (const provider of candidates) {
      const remaining = deadline - now();
      if (remaining < 100) break;
      const group = provider.definition.group;
      if (groups.has(group)) continue;
      groups.add(group);
      const health = provider.health[platform] || (provider.health[platform] = {songs:new Set(), until:0});
      if (health.until > now()) continue;
      try {
        const url = await attempt(provider, input, Math.min(options.timeoutMs, remaining));
        const verdict = await verify(url, Math.max(1, Math.min(1800, deadline - now())));
        if (verdict === 'valid') { health.songs.clear(); health.until = 0; return url; }
        if (!fallback) fallback = url;
      } catch (error) {
        health.songs.add(song);
        if (health.songs.size >= 2) { health.until = now() + options.cooldownMs; health.songs.clear(); }
        errors.push(provider.definition.metadata.name + ': ' + safeError(error));
      }
    }
    if (fallback) return fallback;
    throw new Error(errors.length ? errors.join('\n').slice(0, 900) : 'no available source for platform/quality');
  };
  let queue = Promise.resolve();
  host.on(host.EVENT_NAMES.request, input => {
    const deadline = now() + options.totalTimeoutMs;
    const result = queue.then(() => route(input, deadline));
    queue = result.catch(() => {});
    return result;
  });
  Promise.all(providers.map(p => p.ready)).then(() => {
    const sources = {};
    for (const platform of platforms) {
      const supported = qualities.filter(q => providers.some(p => p.handler && p.capabilities && p.capabilities[platform] && p.capabilities[platform].qualitys.includes(q)));
      if (supported.length) sources[platform] = {type:'music', actions:['musicUrl'], qualitys:supported};
    }
    return host.send(host.EVENT_NAMES.inited, {sources});
  }).catch(() => {});
})(globalThis.lx, globalThis, __TINGJI_DEFINITIONS__, __TINGJI_OPTIONS__);`;
