import {fail, parseResource, packageId, exactVersion, sha256} from './common.mjs';
import {fetchPublicDocument, publicSourceURL} from './network.mjs';
import {unpackPackage, checkPackageVersion, installPackage} from './packages.mjs';

export const DEFINITION_TYPES=['StructureDefinition','ValueSet','CodeSystem','ConceptMap','ImplementationGuide','SearchParameter','OperationDefinition','CapabilityStatement','StructureMap','NamingSystem'];
export function definitionResource(content,project) {
  const resource=parseResource(content,project.fhirVersion);
  if(!DEFINITION_TYPES.includes(resource.resourceType))fail('SOURCE_DEFINITION_REQUIRED','Only FHIR definition resources may enter source workflows.');
  return resource;
}
const identity=r=>Object.fromEntries(['resourceType','id','url','version','name','title','fhirVersion','baseDefinition','copyright'].filter(k=>r[k]!==undefined).map(k=>[k,r[k]]));
async function describe(document,project) {
  const {bytes,url}=document;
  const provenance={sourceUrl:url,sha256:sha256(bytes),retrievedAt:new Date().toISOString(),selectedFhirVersion:project.fhirVersion,clinicalApproval:false};
  if(bytes[0]===0x1f && bytes[1]===0x8b) {
    const files=await unpackPackage(bytes);
    let manifest;try{manifest=JSON.parse(files.get('package/package.json').toString());}catch{fail('PACKAGE_MANIFEST','Invalid package manifest.');}
    packageId(manifest.name);exactVersion(manifest.version);checkPackageVersion(manifest,project);
    return {kind:'package',url,sha256:provenance.sha256,package:{id:manifest.name,version:manifest.version,canonical:manifest.canonical || null,
      fhirVersions:manifest.fhirVersions || manifest['fhir-version-list'] || [manifest.fhirVersion],dependencies:manifest.dependencies || {},license:manifest.license || null,title:manifest.title || manifest.name},provenance};
  }
  const content=bytes.toString('utf8');let resource;
  try{resource=JSON.parse(content);}catch{return null;}
  if(!resource || typeof resource!=='object' || Array.isArray(resource))fail('SOURCE_METADATA','Expected a JSON definition or publication document.');
  if(!resource.resourceType)return {kind:'metadata',document:resource,url,provenance};
  definitionResource(resource,project);
  if(bytes.length>2_097_152)fail('SOURCE_SIZE','Individual definition resources must be within 2 MiB.');
  return {kind:'resource',url,sha256:provenance.sha256,resource,content,identity:identity(resource),provenance};
}
function releases(metadata,url) {
  if(!Array.isArray(metadata.list))fail('SOURCE_METADATA','Expected an IG package-list.json publication history.');
  return metadata.list.filter(item=>typeof item.version==='string' && /^\d+\.\d+\.\d+(?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?$/.test(item.version)
      && item.status!=='ci-build' && typeof item.path==='string')
    .map(item=>({version:item.version,fhirVersion:item.fhirversion || null,status:item.status || null,url:publicSourceURL(new URL(item.path,url).href).href,
      title:item.desc || item.version}));
}
async function publication(document,project,parameters,context) {
  const candidates=releases(document.document,document.url);
  if(!parameters.version)return {kind:'releases',url:document.url,packageId:document.document['package-id'] || null,releases:candidates,
    provenance:document.provenance,note:'Select an exact published package version before importing.'};
  exactVersion(parameters.version);
  const matches=candidates.filter(item=>item.version===parameters.version && (!item.fhirVersion || item.fhirVersion===project.fhirVersion));
  if(matches.length!==1)fail('SOURCE_RELEASE','Select one exact publication compatible with the project FHIR release.');
  const source=await describe(await fetchPublicDocument(new URL('package.tgz',matches[0].url.replace(/\/$/,'')+'/').href,context),project);
  if(source?.kind!=='package' || source.package.version!==parameters.version)fail('SOURCE_RELEASE','Publication must contain the exact selected package archive.');
  return source;
}
export async function inspectSource(parameters,project,context={}) {
  const input=publicSourceURL(parameters.url).href;
  const document=await fetchPublicDocument(input,context);
  const result=await describe(document,project);
  if(result && ['package','resource'].includes(result.kind)) {
    if(parameters.version && result.kind==='package' && result.package.version!==parameters.version)fail('SOURCE_RELEASE','Package does not match the selected version.');
    return result;
  }
  if(result?.kind==='metadata')return publication(result,project,parameters,context);
  // Read only machine-readable publication links; never execute or copy website scripts.
  const base=new URL(document.url);if(!base.pathname.endsWith('/'))base.pathname=base.pathname.split('/').at(-1).includes('.')?base.pathname.slice(0,base.pathname.lastIndexOf('/')+1):base.pathname+'/';
  const urls=new Set([new URL('package-list.json',base).href]);
  for(const match of document.bytes.toString('utf8').matchAll(/\bhref\s*=\s*["']([^"']+)["']/gi)) {
    if(!/(?:package-list\.json|package\.tgz)$/.test(match[1]))continue;
    try{urls.add(publicSourceURL(new URL(match[1],document.url).href).href);}catch{/* Ignore unrelated unsafe links, never fetch them. */}
    if(urls.size>=8)break;
  }
  urls.add(new URL('package.tgz',base).href);
  for(const url of urls) {
    let linked;
    try{linked=await describe(await fetchPublicDocument(url,context),project);}catch(error){
      if(error.code==='SOURCE_HTTP' && /HTTP (404|410)/.test(error.message))continue;
      throw error;
    }
    if(linked?.kind==='metadata')return publication(linked,project,parameters,context);
    if(linked?.kind==='package') {
      if(parameters.version && linked.package.version!==parameters.version)fail('SOURCE_RELEASE','Package does not match the selected version.');
      return linked;
    }
  }
  fail('SOURCE_NOT_FOUND','No published FHIR package or definition resource was found; provide its JSON or package URL.');
}
export async function sourceOperation(operation,parameters,project,context) {
  const source=await inspectSource(parameters,project,context);
  if(operation==='source.inspect')return source;
  if(source.kind==='releases')fail('SOURCE_RELEASE','Choose an exact release before importing.');
  if(!/^[a-f0-9]{64}$/.test(parameters.expectedSha256 || '') || source.sha256!==parameters.expectedSha256)
    fail('SOURCE_CHANGED','Inspect the exact source bytes and confirm their hash before importing.');
  if(source.kind==='resource')return source;
  const {id,version}=source.package;
  const dependency={id,version,url:source.url,sha256:source.sha256};
  const installed=await installPackage(dependency,project,context);
  return {...source,dependency,installed};
}
