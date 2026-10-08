import https from 'node:https';
import { lookup } from 'node:dns';
import { isIP } from 'node:net';
import { EngineError, fail } from './common.mjs';

export const DEFAULT_REGISTRY = 'https://packages.fhir.org';
const DEFAULT_ORIGINS = ['https://packages.fhir.org', 'https://packages2.fhir.org', 'https://packages.simplifier.net'];
export function isPrivate(address) {
  const a = address.toLowerCase();
  if (isIP(a) === 4) {
    const [x,y] = a.split('.').map(Number);
    return x === 0 || x === 10 || x === 127 || x >= 224 || (x === 169 && y === 254) || (x === 172 && y >= 16 && y <= 31) || (x === 192 && (y === 168 || y === 0)) || (x === 100 && y >= 64 && y <= 127) || (x === 198 && [18,19].includes(y));
  }
  // Only global-unicast IPv6; reject mapped IPv4, local, multicast and transition ranges.
  return isIP(a) !== 6 || !/^[23]/.test(a) || a.startsWith('2001:db8:') || a.startsWith('2002:');
}
export function approvedURL(input, context = {}) {
  let url; try { url = new URL(input); } catch { fail('SOURCE_URL', 'Invalid package source URL.'); }
  const origins = context.allowedOrigins || (process.env.FHIR_PACKAGE_ORIGINS ? process.env.FHIR_PACKAGE_ORIGINS.split(',').map(x=>x.trim()) : DEFAULT_ORIGINS);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || !origins.includes(url.origin) || (isIP(url.hostname.replace(/^\[|\]$/g,'')) && isPrivate(url.hostname.replace(/^\[|\]$/g,'')))) fail('SOURCE_DENIED', 'Package source must be an administrator-allowed HTTPS origin without credentials.');
  return url;
}
export function publicLookup(host, options, cb) {
  lookup(host, { all: true, verbatim: true }, (error, addresses) => {
    if (error) return cb(error);
    if (!addresses.length || addresses.some(a => isPrivate(a.address))) return cb(new EngineError('SOURCE_DENIED', 'Source resolves to a non-public address.'));
    if (options.all) return cb(null, addresses);
    cb(null, addresses[0].address, addresses[0].family);
  });
}
export async function fetchBuffer(input, context = {}, maxBytes = 60_000_000) {
  const url = approvedURL(input, context);
  if (context.fetchBuffer) return context.fetchBuffer(url.href, maxBytes); // Dependency injection is available only in-process, never via HTTP parameters.
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      timeout: 60_000,
      headers: { 'User-Agent': 'openEHR-FHIR-Modeller/0.1', Accept: '*/*' },
      lookup:publicLookup,
    }, res => {
      if (res.statusCode !== 200) { res.resume(); reject(new EngineError('SOURCE_HTTP', `Package registry returned HTTP ${res.statusCode}; redirects are not followed.`, 502)); return; }
      if (Number(res.headers['content-length'] || 0) > maxBytes) { res.destroy(); reject(new EngineError('DOWNLOAD_SIZE', 'Package download exceeds configured limit.')); return; }
      const chunks = []; let size = 0;
      res.on('data', b => { size += b.length; if (size > maxBytes) { res.destroy(); reject(new EngineError('DOWNLOAD_SIZE', 'Package download exceeds configured limit.')); } else chunks.push(b); });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new EngineError('SOURCE_TIMEOUT', 'Package registry timed out.', 504)));
    req.on('error', reject);
  });
}

// Public definition sources are distinct from administrator-selected registries.
// Never forward connection credentials or permit local-network destinations.
export function publicSourceURL(input) {
  let url; try { url = new URL(input); } catch { fail('SOURCE_URL', 'Invalid source URL.'); }
  const allowed = process.env.FHIR_SOURCE_ORIGINS?.split(',').map(x => x.trim()).filter(Boolean);
  if (typeof input !== 'string' || input.length > 2000 || url.protocol !== 'https:' || url.username || url.password || url.hash || url.search
      || (url.port && url.port !== '443') || (allowed?.length && !allowed.includes(url.origin))
      || url.hostname === 'localhost' || url.hostname.endsWith('.localhost') || (isIP(url.hostname.replace(/^\[|\]$/g,'')) && isPrivate(url.hostname.replace(/^\[|\]$/g,''))))
    fail('SOURCE_DENIED', 'Use a public HTTPS definition URL without credentials, queries or a custom port.');
  return url;
}
export async function fetchPublicDocument(input, context = {}, maxBytes = 60_000_000, redirects = 0) {
  const url = publicSourceURL(input);
  if (context.fetchPublicDocument) {
    const result = await context.fetchPublicDocument(url.href, maxBytes);
    publicSourceURL(result.url || url.href);
    if (!Buffer.isBuffer(result.bytes) || result.bytes.length > maxBytes) fail('DOWNLOAD_SIZE', 'Source download exceeds the limit.');
    return {...result, url:result.url || url.href};
  }
  return new Promise((resolve, reject) => {
    const req = https.get(url, {timeout:30_000, lookup:publicLookup,
      headers:{'User-Agent':'openEHR-FHIR-Modeller/0.1', Accept:'application/fhir+json, application/json, text/html, */*'}}, res => {
      if ([301,302,303,307,308].includes(res.statusCode)) {
        res.resume();
        if (redirects >= 3 || !res.headers.location) return reject(new EngineError('SOURCE_REDIRECT', 'Source redirect limit exceeded.'));
        try { resolve(fetchPublicDocument(new URL(res.headers.location,url).href,context,maxBytes,redirects+1)); } catch (error) { reject(error); }
        return;
      }
      if (res.statusCode !== 200) {res.resume();reject(new EngineError('SOURCE_HTTP', `Definition source returned HTTP ${res.statusCode}.`,502));return;}
      if (Number(res.headers['content-length'] || 0) > maxBytes) {res.destroy();reject(new EngineError('DOWNLOAD_SIZE','Source download exceeds the limit.'));return;}
      const chunks=[];let size=0;
      res.on('data',chunk=>{size+=chunk.length;if(size>maxBytes)res.destroy(new EngineError('DOWNLOAD_SIZE','Source download exceeds the limit.'));else chunks.push(chunk);});
      res.on('end',()=>resolve({bytes:Buffer.concat(chunks),url:url.href,contentType:res.headers['content-type'] || ''}));
      res.on('error',reject);
    });
    req.on('timeout',()=>req.destroy(new EngineError('SOURCE_TIMEOUT','Definition source timed out.',504)));
    req.on('error',reject);
  });
}
