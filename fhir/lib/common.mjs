import { createHash } from 'node:crypto';
import { mkdir, writeFile, rename, readFile } from 'node:fs/promises';
import path from 'node:path';

export class EngineError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
export const fail = (code, message, status) => { throw new EngineError(code, message, status); };
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const canonicalJSON = value => JSON.stringify(normalize(value));
function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, normalize(value[k])]));
  return value;
}
export const RELEASES = { R4: '4.0.1', R4B: '4.3.0', R5: '5.0.0' };
export const CORES = { '4.0.1': 'hl7.fhir.r4.core', '4.3.0': 'hl7.fhir.r4b.core', '5.0.0': 'hl7.fhir.r5.core' };
// The official R4 4.0.1 core archive preserves several 4.0.0 declarations.
// This is the same R4 release family; never extend it to R4B or R5.
export const artifactVersionMatches=(declared,selected)=>Array.isArray(declared)?declared.some(v=>artifactVersionMatches(v,selected)):declared===release(selected)||(release(selected)==='4.0.1'&&declared==='4.0.0');
export function release(value) {
  const result = RELEASES[value] || value;
  if (!Object.hasOwn(CORES, result) && (typeof result !== 'string' || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?(?:\+[A-Za-z0-9.-]+)?$/.test(result)))
    fail('FHIR_VERSION', 'Declare an exact FHIR release. Additional releases support definition inspection; authoring requires an installed compatible processor.');
  return result;
}
export function projectConfig(project) {
  if (!project || typeof project !== 'object') fail('PROJECT_REQUIRED', 'A FHIR project is required.');
  const p = { ...project, fhirVersion: release(project.fhirVersion), dependencies: project.dependencies || [], sources: project.sources || [] };
  if (!Array.isArray(p.dependencies) || !Array.isArray(p.sources) || p.dependencies.length > 100 || p.sources.length > 30) fail('PROJECT_CONFIG', 'Invalid dependency/source configuration.');
  for (const d of p.dependencies) { packageId(d.id); exactVersion(d.version); }
  return p;
}
export function packageId(id) {
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9._-]{1,150}$/.test(id)) fail('PACKAGE_ID', 'Invalid FHIR package identifier.');
  return id;
}
export function exactVersion(value) {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?(?:\+[A-Za-z0-9.-]+)?$/.test(value)) fail('UNPINNED_VERSION', 'An exact package version is required; ranges, latest, current and dev are not allowed.');
  return value;
}
export function parseResource(content, version) {
  let resource;
  try { resource = typeof content === 'string' ? JSON.parse(content) : structuredClone(content); } catch { fail('INVALID_JSON', 'FHIR resource must be valid JSON. Original source is not modified.'); }
  if (!resource || typeof resource !== 'object' || Array.isArray(resource) || typeof resource.resourceType !== 'string' || !/^[A-Z][A-Za-z0-9]+$/.test(resource.resourceType)) fail('RESOURCE_REQUIRED', 'A FHIR JSON resource with resourceType is required.');
  if (Buffer.byteLength(JSON.stringify(resource)) > 5_000_000) fail('RESOURCE_SIZE', 'Resource exceeds 5 MB.');
  if (version && resource.fhirVersion && !artifactVersionMatches(resource.fhirVersion,version)) fail('FHIR_VERSION_MISMATCH', `Artifact declares ${resource.fhirVersion}; project requires ${release(version)}.`);
  return resource;
}
export function canonical(value, label = 'canonical') {
  if (typeof value !== 'string' || value.length > 2000 || /[\s"'<>\\]/.test(value)) fail('CANONICAL', `Invalid ${label}.`);
  try { const u = new URL(value.split('|')[0]); if (!['http:', 'https:', 'urn:'].includes(u.protocol) || u.username || u.password) throw Error(); } catch { fail('CANONICAL', `Invalid ${label}.`); }
  return value;
}
export function safeFile(value) {
  if (typeof value !== 'string' || value.length > 240 || value.startsWith('/') || value.includes('\\') || value.split('/').some(p => !p || p === '.' || p === '..') || /[\x00-\x1f]/.test(value)) fail('UNSAFE_PATH', 'Source filenames must be safe relative paths.');
  return value;
}
export async function tenantRoot(context = {}) {
  if (typeof context.tenant !== 'string' || !context.tenant || context.tenant.length > 300) fail('TENANT_REQUIRED', 'Authenticated tenant context is required.', 401);
  const root = path.join(context.dataDir || process.env.FHIR_DATA_DIR || '/data/fhir', sha256(context.tenant));
  await mkdir(root, { recursive: true, mode: 0o700 });
  return root;
}
export async function jsonRead(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT' && fallback !== undefined) return fallback; throw e; }
}
export async function atomicJSON(file, data) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await rename(tmp, file);
}
export function references(resource) {
  const found = new Set();
  function visit(value, key = '') {
    if (Array.isArray(value)) value.forEach(v => visit(v, key));
    else if (value && typeof value === 'object') Object.entries(value).forEach(([k, v]) => visit(v, k));
    else if (typeof value === 'string' && ['baseDefinition','profile','targetProfile','valueSet','system','definition','instantiatesCanonical','supplements','sourceCanonical','targetCanonical','valueCanonical'].includes(key) && /^(https?:|urn:)/.test(value)) found.add(value);
  }
  visit(resource); return [...found].sort();
}
