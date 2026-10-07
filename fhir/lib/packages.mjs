import { mkdir, readFile, writeFile, mkdtemp, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { Parser } from 'tar';
import { fail, packageId, exactVersion, sha256, jsonRead, atomicJSON, tenantRoot, references, safeFile, CORES, artifactVersionMatches } from './common.mjs';
import { DEFAULT_REGISTRY, approvedURL, fetchBuffer } from './network.mjs';

function sourceURL(source, project, context) {
  const configured = project.sources.find(s => s.id === source);
  const url = configured?.url || source || DEFAULT_REGISTRY;
  const parsed = approvedURL(url, context);
  if (parsed.search) fail('SOURCE_URL', 'Registry source cannot contain query parameters.');
  return parsed.href.replace(/\/$/, '');
}
export function checkPackageVersion(manifest, project) {
  const versions = manifest.fhirVersions || manifest['fhir-version-list'] || (manifest.fhirVersion ? [manifest.fhirVersion] : []);
  if (!Array.isArray(versions) || !versions.includes(project.fhirVersion)) fail('FHIR_VERSION_MISMATCH', `Package ${manifest.name}#${manifest.version} does not declare compatibility with FHIR ${project.fhirVersion}.`);
  for (const [id, v] of Object.entries(manifest.dependencies || {})) { packageId(id); exactVersion(v); if (/^hl7\.fhir\.r[45]/.test(id) && (id !== CORES[project.fhirVersion] || v !== project.fhirVersion)) fail('FHIR_VERSION_MISMATCH', 'Package depends on a different FHIR core release.'); }
}
export async function unpackPackage(buffer) {
  let raw; try { raw = gunzipSync(buffer, { maxOutputLength: 250_000_000 }); } catch { fail('PACKAGE_ARCHIVE', 'Package must be a gzip tar archive within the 250 MB expanded limit.'); }
  const files = new Map(); let bytes = 0; let count = 0;
  await new Promise((resolve, reject) => {
    const parser = new Parser({ strict: true, onReadEntry(entry) {
      try {
        count++; if (count > 40_000) fail('PACKAGE_SIZE', 'Too many package entries.');
        const name = entry.path.replace(/^\.\//, '').replace(/\/$/, ''); safeFile(name);
        if (!['File', 'Directory', 'OldFile'].includes(entry.type)) fail('PACKAGE_PATH', 'Archive links and special entries are prohibited.');
        if (entry.type === 'Directory') { entry.resume(); return; }
        if (entry.size > 30_000_000 || (bytes += entry.size) > 250_000_000 || files.has(name)) fail('PACKAGE_SIZE', 'Duplicate or oversized package entry.');
        // Published HL7 core archives also contain supplemental openapi/ and
        // other/ files. Validate every path/type/size, but extract only package/.
        // The original archive hash still covers all bytes for provenance.
        if (!name.startsWith('package/')) { entry.resume(); return; }
        const parts = [];
        entry.on('data', data => parts.push(data));
        entry.on('end', () => files.set(name, Buffer.concat(parts)));
        entry.on('error', reject);
      } catch (e) { reject(e); entry.resume(); }
    } });
    parser.on('error', reject); parser.on('end', resolve); parser.end(raw);
  });
  if (!files.has('package/package.json')) fail('PACKAGE_MANIFEST', 'FHIR package lacks package/package.json.');
  return files;
}
function indexResource(resource, file, info) {
  return { ...Object.fromEntries(['resourceType','id','url','version','name','title','type','kind','derivation','baseDefinition','status','description'].filter(k=>resource[k] !== undefined).map(k=>[k, resource[k]])), references: references(resource), file, package: info.id, packageVersion: info.version, fhirVersion: info.fhirVersion, source: info.source, jurisdiction: info.jurisdiction, sha256: sha256(JSON.stringify(resource)) };
}
export async function installPackage(parameters, project, context, state) {
  const id = packageId(parameters.id), version = exactVersion(parameters.version);
  const root = await tenantRoot(context);
  state ||= { selected: new Map(), active: new Set(), packages: [], nodes: 0 };
  if (state.selected.has(id) && state.selected.get(id) !== version) fail('DEPENDENCY_CONFLICT', `Package ${id} requested at both ${state.selected.get(id)} and ${version}; explicit resolution is required.`);
  if (state.selected.has(id)) return state.packages.find(p=>p.id === id) || { id, version, cycle: true };
  if (++state.nodes > 150) fail('DEPENDENCY_LIMIT', 'Dependency graph exceeds 150 packages.');
  state.selected.set(id, version); state.active.add(id);
  const source = sourceURL(parameters.source, project, context);
  const key = sha256(`${source}|${id}|${version}|${project.fhirVersion}`);
  const dir = path.join(root, 'packages', key);
  let info = await jsonRead(path.join(dir, 'info.json'), null);
  if (!info) {
    const buffer = await fetchBuffer(`${source}/${encodeURIComponent(id)}/${encodeURIComponent(version)}`, context);
    const files = await unpackPackage(buffer);
    let manifest; try { manifest = JSON.parse(files.get('package/package.json')); } catch { fail('PACKAGE_MANIFEST', 'Invalid package manifest JSON.'); }
    if (manifest.name !== id || manifest.version !== version) fail('PACKAGE_IDENTITY', 'Downloaded package does not match the exact requested package ID and version.');
    checkPackageVersion(manifest, project);
    info = { id, version, fhirVersion: project.fhirVersion, source, canonical: manifest.canonical || manifest.url || null, dependencies: manifest.dependencies || {}, jurisdiction: manifest.jurisdiction || null, sha256: sha256(buffer), installedAt: new Date().toISOString(), key, artifactCount: 0 };
    const index = [];
    for (const [name, bytes] of files) {
      if (!name.endsWith('.json') || name.includes('/examples/') || name === 'package/package.json' || name.endsWith('/.index.json')) continue;
      let resource; try { resource = JSON.parse(bytes.toString('utf8')); } catch { continue; }
      if (!resource.resourceType) continue;
      if (resource.fhirVersion && !artifactVersionMatches(resource.fhirVersion,project.fhirVersion)) fail('FHIR_VERSION_MISMATCH', `Package artifact ${name} declares ${resource.fhirVersion}.`);
      index.push(indexResource(resource, name, info));
    }
    const seen = new Set();
    for (const item of index.filter(x=>x.url)) { const identity = `${item.url}|${item.version || ''}`; if (seen.has(identity)) fail('CANONICAL_CONFLICT', `Package contains duplicate canonical ${identity}.`); seen.add(identity); }
    info.artifactCount = index.length;
    await mkdir(path.dirname(dir), { recursive: true, mode: 0o700 });
    const staging = await mkdtemp(path.join(root, 'packages', '.install-'));
    try {
      for (const [name, bytes] of files) { const file = path.join(staging, name); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, bytes, { mode: 0o600 }); }
      await atomicJSON(path.join(staging, 'info.json'), info); await atomicJSON(path.join(staging, 'index.json'), index);
      await writeFile(path.join(staging, 'package.tgz'), buffer, { mode: 0o600 });
      try { await rename(staging, dir); } catch (e) { if (!['EEXIST','ENOTEMPTY'].includes(e.code)) throw e; }
    } finally { await rm(staging, { recursive: true, force: true }); }
  }
  state.packages.push(info);
  for (const [dep, v] of Object.entries(info.dependencies)) {
    const configured = project.dependencies.find(d=>d.id === dep);
    if (configured && configured.version !== v) fail('DEPENDENCY_CONFLICT', `Configured ${dep}#${configured.version} conflicts with required ${v}.`);
    await installPackage({ id: dep, version: v, source: configured?.source || parameters.source }, project, context, state);
  }
  state.active.delete(id);
  return { ...info, lock: state.packages.map(p=>({ id:p.id, version:p.version, fhirVersion:p.fhirVersion, source:p.source, sha256:p.sha256, key:p.key })) };
}
export async function resolveDependencies(project, context) {
  const state = { selected: new Map(), active: new Set(), packages: [], nodes: 0 };
  await installPackage({ id: CORES[project.fhirVersion], version: project.fhirVersion }, project, context, state);
  for (const d of project.dependencies) await installPackage(d, project, context, state);
  const lock = state.packages.map(p=>({ id:p.id, version:p.version, fhirVersion:p.fhirVersion, source:p.source, sha256:p.sha256, key:p.key }));
  return { fhirVersion:project.fhirVersion, packages:lock, fingerprint:sha256(JSON.stringify(lock)), source:'resolved-exact-package-manifests' };
}
export async function artifactSearch(parameters, project, context) {
  const lock = await resolveDependencies(project, context); const root = await tenantRoot(context); const all = [];
  for (const p of lock.packages) all.push(...await jsonRead(path.join(root,'packages',p.key,'index.json')));
  const query = String(parameters.query || '').toLowerCase();
  const matches = all.filter(item => (!parameters.id || item.package === parameters.id) && (!parameters.resourceType || item.resourceType === parameters.resourceType) && (!parameters.baseResource || item.type === parameters.baseResource) && (!parameters.parent || item.baseDefinition === parameters.parent) && (!parameters.canonical || item.url === parameters.canonical.split('|')[0]) && (!parameters.terminology || item.references.includes(parameters.terminology)) && (!query || [item.name,item.title,item.id,item.description,item.url].some(x=>x?.toLowerCase().includes(query))));
  const offset = Number(parameters.offset || 0), limit = Number(parameters.limit || 100);
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 1000) fail('PAGINATION', 'Limit must be 1..1000 and offset non-negative.');
  return { items:matches.slice(offset,offset+limit), total:matches.length, lock };
}
export async function resolveArtifact(parameters, project, context) {
  if (!parameters.canonical) fail('CANONICAL_REQUIRED', 'An artifact canonical is required.');
  const [url, embeddedVersion] = parameters.canonical.split('|');
  const version = parameters.version || embeddedVersion;
  const found = await artifactSearch({ canonical:url, limit:1000 }, project, context);
  const matches = found.items.filter(i=>(!version || i.version === version) && (!parameters.id || i.package === parameters.id));
  if (!matches.length) fail('CANONICAL_UNRESOLVED', `Canonical ${parameters.canonical} is absent from the exact dependency graph.`, 404);
  const identities = new Set(matches.map(i=>`${i.version || ''}|${i.sha256}`));
  if (identities.size > 1) fail('CANONICAL_CONFLICT', `Canonical ${url} has multiple versions or definitions; specify a version and package.`);
  const selected = matches[0], pkg = found.lock.packages.find(p=>p.id === selected.package);
  const root = await tenantRoot(context);
  return { resource:await jsonRead(path.join(root,'packages',pkg.key,selected.file)), provenance:selected, lock:found.lock };
}
export async function packageOperation(operation, parameters, project, context) {
  if (operation === 'package.install') return installPackage(parameters, project, context);
  if (operation === 'package.dependencies') return resolveDependencies(project, context);
  if (operation === 'package.artifacts') return artifactSearch(parameters, project, context);
  if (operation === 'package.resolve') return resolveArtifact(parameters, project, context);
  if (operation === 'package.get') {
    if (parameters.version) return installPackage(parameters, project, context);
    const id = packageId(parameters.id); const source = sourceURL(parameters.source,project,context);
    const data = JSON.parse((await fetchBuffer(`${source}/${encodeURIComponent(id)}`, context,5_000_000)).toString());
    return { id, source, metadata:data, installed:false, note:'Select and persist an exact version before installation.' };
  }
  const lock = await resolveDependencies(project,context); const root=await tenantRoot(context); const items=[];
  for(const p of lock.packages) { const info=await jsonRead(path.join(root,'packages',p.key,'info.json')); if(!parameters.query || info.id.includes(parameters.query)) items.push(info); }
  return { items,total:items.length,scope:'configured exact dependency graph; package.get retrieves registry versions by ID' };
}
