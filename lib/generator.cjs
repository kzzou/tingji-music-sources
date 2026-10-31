"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateSourceBundle = exports.inspectSources = exports.utf8Size = exports.MAX_SOURCE_COUNT = exports.MAX_BUNDLE_BYTES = exports.MAX_SOURCE_BYTES = void 0;
const runtimeTemplate_1 = require("./runtimeTemplate.cjs");
exports.MAX_SOURCE_BYTES = 1024 * 1024;
exports.MAX_BUNDLE_BYTES = 6 * 1024 * 1024;
exports.MAX_SOURCE_COUNT = 24;
const utf8Size = (text) => {
    let bytes = 0;
    for (let index = 0; index < text.length; index++) {
        const code = text.charCodeAt(index);
        if (code < 0x80) bytes++;
        else if (code < 0x800) bytes += 2;
        else if (code >= 0xD800 && code <= 0xDBFF) {
            const next = text.charCodeAt(index + 1);
            if (!(next >= 0xDC00 && next <= 0xDFFF)) throw new URIError('URI malformed');
            bytes += 4;
            index++;
        } else {
            if (code >= 0xDC00 && code <= 0xDFFF) throw new URIError('URI malformed');
            bytes += 3;
        }
    }
    return bytes;
};
exports.utf8Size = utf8Size;
const metadata = (code) => {
    const header = /^\uFEFF?\s*\/\*[\s\S]*?\*\//.exec(code)?.[0];
    if (!header)
        throw new Error('missing source header');
    if (/@tingji-generated\s+1\b/.test(header))
        throw new Error('generated source cannot be nested');
    const result = {};
    for (const key of ['name', 'version', 'description', 'author', 'homepage']) {
        result[key] = new RegExp(`@${key}[ \t]+([^\r\n]*)`).exec(header)?.[1].trim() ?? '';
    }
    if (!result.name)
        throw new Error('missing @name');
    return result;
};
// Compile only in the app's JS engine, never invoke downloaded script bodies here.
const checkSyntax = (code) => {
    // eslint-disable-next-line no-new-func, @typescript-eslint/no-implied-eval -- Compilation only; the returned function is never invoked.
    void new Function('globalThis', 'lx', 'window', 'self', 'setTimeout', 'clearTimeout', code);
};
const inspectSources = (inputs) => {
    const sources = [];
    const duplicates = [];
    const rejected = [];
    const warnings = [];
    const seen = new Set();
    if (inputs.length > exports.MAX_SOURCE_COUNT)
        throw new Error(`source count exceeds ${exports.MAX_SOURCE_COUNT}`);
    for (const [index, input] of inputs.entries()) {
        let name = input.name ?? input.path ?? `source-${index + 1}`;
        try {
            if (input.error)
                throw new Error(input.error);
            if (typeof input.rawCode !== 'string' || (0, exports.utf8Size)(input.rawCode) > exports.MAX_SOURCE_BYTES)
                throw new Error('source exceeds 1 MiB');
            const info = metadata(input.rawCode);
            name = info.name;
            checkSyntax(input.rawCode);
            if (seen.has(input.rawCode)) {
                duplicates.push({ name, reason: 'identical source content' });
                continue;
            }
            seen.add(input.rawCode);
            sources.push({ ...input, ...info, id: input.id ?? `source-${index + 1}` });
        }
        catch (error) {
            rejected.push({ name, reason: error.message });
        }
    }
    if (sources.some(input => input.rawCode.length > 250000))
        warnings.push('large scripts may take longer to initialize');
    return { sources, duplicates, rejected, warnings };
};
exports.inspectSources = inspectSources;
const bounded = (value, fallback, min, max) => Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
const headerText = (text) => text.replace(/\*\//g, '* /').replace(/[\r\n]/g, ' ').slice(0, 24);
const generateSourceBundle = (inputs, options = {}) => {
    const cleaned = (0, exports.inspectSources)(inputs);
    if (!cleaned.sources.length)
        throw new Error('no valid source selected');
    const definitions = cleaned.sources.map((input, index) => {
        const info = {
            name: input.name ?? '',
            version: input.version ?? '',
            description: input.description ?? '',
            author: input.author ?? '',
            homepage: input.homepage ?? '',
        };
        const values = {
            id: input.id,
            provenance: { path: input.path, sha256: input.sha256 },
            metadata: info,
            rawCode: input.rawCode,
            priority: input.priority ?? index,
            platformPriorities: input.platformPriorities,
            group: input.endpointGroup ?? input.id,
            verifiedCapabilities: input.verifiedCapabilities,
            mode: input.musicInfoMode ?? 'enriched',
        };
        const prefix = JSON.stringify(values).slice(0, -1);
        return `${prefix},"factory":function(globalThis,lx,window,self,setTimeout,clearTimeout){\n${input.rawCode}\n}}`;
    });
    const runtimeOptions = {
        timeoutMs: bounded(options.timeoutMs, 4500, 500, 8000),
        cooldownMs: bounded(options.cooldownMs, 60000, 1000, 600000),
        initTimeoutMs: 6000,
        totalTimeoutMs: 16000,
    };
    const runtime = runtimeTemplate_1.aggregateRuntime.replace(/__TINGJI_(DEFINITIONS|OPTIONS)__/g, (_, key) => key === 'DEFINITIONS' ? `[${definitions.join(',\n')}]` : JSON.stringify(runtimeOptions));
    const script = `/*!\n * @name ${headerText(options.name ?? '听己聚合音源')}\n * @description 字段适配、重复清洗与解析失败回退\n * @version 1.0.0\n * @author Tingji\n * @tingji-generated 1\n */\n${runtime}\n`;
    const bytes = (0, exports.utf8Size)(script);
    if (bytes > exports.MAX_BUNDLE_BYTES)
        throw new Error('generated source exceeds 6 MiB; select fewer sources');
    checkSyntax(script);
    return {
        script,
        report: {
            included: cleaned.sources.map(input => input.name ?? ''),
            duplicates: cleaned.duplicates,
            rejected: cleaned.rejected,
            warnings: cleaned.warnings,
            bytes,
        },
    };
};
exports.generateSourceBundle = generateSourceBundle;
