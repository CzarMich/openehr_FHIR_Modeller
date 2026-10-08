import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { create } from 'tar';
import { execute } from '../engine.mjs';
import { projectConfig, release, exactVersion, safeFile, parseResource } from '../lib/common.mjs';
import { approvedURL, publicSourceURL, isPrivate } from '../lib/network.mjs';
import { unpackPackage } from '../lib/packages.mjs';
import { constraintsToFsh } from '../lib/modelling.mjs';
import { createServer } from '../server.mjs';
import { checkToolReadiness } from '../lib/readiness.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const project={fhirVersion:'4.0.1',canonical:'https://example.org/fhir',packageId:'test.modeller',version:'0.1.0',dependencies:[],sources:[]};
async function archive(manifest,resources=[],extra) {
  const dir=await mkdtemp(path.join(os.tmpdir(),'fhir-package-test-'));
  try {await mkdir(path.join(dir,'package'));await writeFile(path.join(dir,'package','package.json'),JSON.stringify(manifest));for(const [i,r]of resources.entries())await writeFile(path.join(dir,'package',`${i}.json`),JSON.stringify(r));if(extra)await extra(dir);await create({gzip:true,file:path.join(dir,'package.tgz'),cwd:dir},['package']);return await readFile(path.join(dir,'package.tgz'));}finally{await rm(dir,{recursive:true,force:true});}
}
async function context(t,packages={}) {
  const dataDir=await mkdtemp(path.join(os.tmpdir(),'fhir-engine-test-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
  const core=await archive({name:'hl7.fhir.r4.core',version:'4.0.1',fhirVersions:['4.0.1']},[{resourceType:'StructureDefinition',id:'Observation',url:'http://hl7.org/fhir/StructureDefinition/Observation',version:'4.0.1',fhirVersion:'4.0.1',name:'Observation',type:'Observation',kind:'resource',derivation:'specialization',snapshot:{element:[{id:'Observation',path:'Observation',min:0,max:'*'}]}}]);
  const calls=[];
  return {tenant:'test-user',dataDir,calls,fetchBuffer:async url=>{calls.push(url);if(url.endsWith('/hl7.fhir.r4.core/4.0.1'))return core;const name=new URL(url).pathname.slice(1);if(packages[name])return packages[name];throw Error(`Unexpected test fetch ${url}`);}};
}
test('releases are explicit and package versions are pinned',()=>{
  for(const [input,want]of [['R4','4.0.1'],['R4B','4.3.0'],['R5','5.0.0']])assert.equal(release(input),want);
  for(const bad of [undefined,'4.0','latest','R6'])assert.throws(()=>release(bad));
  for(const bad of ['latest','current','^1.0.0','1.0','../1.0.0'])assert.throws(()=>exactVersion(bad));
  assert.equal(exactVersion('2026.0.0-ballot'), '2026.0.0-ballot');
  assert.throws(()=>projectConfig({fhirVersion:'R4',dependencies:[{id:'foo',version:'latest'}]}));
});
test('package URL policy rejects credentials, HTTP, arbitrary hosts and private DNS addresses',()=>{
  for(const url of ['http://packages.fhir.org/a','https://evil.test/a','https://user:password@packages.fhir.org/a','https://127.0.0.1/a'])assert.throws(()=>approvedURL(url));
  assert.equal(approvedURL('https://packages.fhir.org/hl7.fhir.r4.core').host,'packages.fhir.org');
  for(const ip of ['127.0.0.1','10.0.0.2','169.254.169.254','172.20.1.1','192.168.1.1','::1','::ffff:127.0.0.1','fe80::1'])assert.equal(isPrivate(ip),true,ip);
  assert.equal(isPrivate('8.8.8.8'),false);
});
test('package archives reject links and unsafe source file paths',async()=>{
  for(const value of ['../x','/etc/passwd','a/../b','a\\b','a//b'])assert.throws(()=>safeFile(value));
  const malicious=await archive({name:'test.pkg',version:'1.0.0'},[],dir=>symlink('/etc/passwd',path.join(dir,'package','escape')));
  await assert.rejects(()=>unpackPackage(malicious),/links and special/);
});
test('official R4 patch declarations preserve their version without allowing R4B or R5',()=>{
  const artifact={resourceType:'StructureDefinition',fhirVersion:'4.0.0'};
  assert.equal(parseResource(artifact,'4.0.1').fhirVersion,'4.0.0');
  assert.throws(()=>parseResource(artifact,'4.3.0'),/project requires/);
  assert.throws(()=>parseResource({...artifact,fhirVersion:'5.0.0'},'4.0.1'),/project requires/);
});
test('safe supplemental core archive content is ignored, never extracted into package cache',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'fhir-core-layout-test-'));
  try {
    await mkdir(path.join(dir,'package'));await mkdir(path.join(dir,'openapi'));
    await writeFile(path.join(dir,'package/package.json'),'{}');await writeFile(path.join(dir,'openapi/Patient.schema.json'),'{}');
    await create({gzip:true,file:path.join(dir,'package.tgz'),cwd:dir},['package','openapi']);
    const files=await unpackPackage(await readFile(path.join(dir,'package.tgz')));
    assert.deepEqual([...files.keys()],['package/package.json']);
  } finally {await rm(dir,{recursive:true,force:true});}
});
test('exact package graph caches provenance and tenant data stays separate',async t=>{
  const ctx=await context(t);
  const first=await execute('package.dependencies',{project},ctx);
  const second=await execute('package.dependencies',{project},ctx);
  assert.equal(first.fingerprint,second.fingerprint);assert.equal(ctx.calls.length,1);assert.match(first.packages[0].sha256,/^[a-f0-9]{64}$/);
  await execute('package.dependencies',{project},{...ctx,tenant:'different-user'});assert.equal(ctx.calls.length,2);
  const result=await execute('package.resolve',{project,canonical:'http://hl7.org/fhir/StructureDefinition/Observation'},ctx);
  assert.equal(result.resource.type,'Observation');assert.equal(result.provenance.packageVersion,'4.0.1');
});
test('package release mismatch and transitive version conflicts fail',async t=>{
  const packages={
    'test.wrong/1.0.0':await archive({name:'test.wrong',version:'1.0.0',fhirVersions:['5.0.0']}),
    'test.parent/1.0.0':await archive({name:'test.parent',version:'1.0.0',fhirVersions:['4.0.1'],dependencies:{'test.child':'1.0.0'}}),
  };
  const ctx=await context(t,packages);
  await assert.rejects(()=>execute('package.install',{project,id:'test.wrong',version:'1.0.0'},ctx),/compatibility/);
  await assert.rejects(()=>execute('package.install',{project:{...project,dependencies:[{id:'test.child',version:'2.0.0'}]},id:'test.parent',version:'1.0.0'},ctx),/conflicts/);
});
test('canonical ambiguity is reported rather than picking arbitrary dependency',async t=>{
  const resource={resourceType:'StructureDefinition',url:'https://example.org/ambiguous',id:'ambiguous',type:'Observation',fhirVersion:'4.0.1'};
  const packages={};for(const [id,version]of [['test.a','1.0.0'],['test.b','2.0.0']])packages[`${id}/1.0.0`]=await archive({name:id,version:'1.0.0',fhirVersions:['4.0.1']},[{...resource,version}]);
  const ctx=await context(t,packages),p={...project,dependencies:[{id:'test.a',version:'1.0.0'},{id:'test.b',version:'1.0.0'}]};
  await assert.rejects(()=>execute('package.resolve',{project:p,canonical:resource.url},ctx),/multiple versions/);
  const resolved=await execute('package.resolve',{project:p,canonical:resource.url+'|2.0.0'},ctx);assert.equal(resolved.resource.version,'2.0.0');
});
test('semantic diff catches restrictive cardinality, binding, targets and dependent impact',async t=>{
  const ctx=await context(t);
  const before={resourceType:'StructureDefinition',url:'https://example.org/a',fhirVersion:'4.0.1',snapshot:{element:[{id:'Observation.subject',path:'Observation.subject',min:0,max:'1',type:[{code:'Reference',targetProfile:['http://hl7.org/fhir/StructureDefinition/Patient']}]},{id:'Observation.code',path:'Observation.code',binding:{strength:'preferred',valueSet:'https://example.org/codes|1.0.0'}}]}};
  const after=structuredClone(before);after.snapshot.element[0].min=1;after.snapshot.element[1].binding={strength:'required',valueSet:'https://example.org/codes|2.0.0'};
  const result=await execute('artifact.diff',{project,before,after,dependents:[{resourceType:'StructureDefinition',url:'https://example.org/child',baseDefinition:before.url}]},ctx);
  assert.equal(result.classification,'breaking');assert.equal(result.impact[0].artifact,'https://example.org/child');assert.ok(result.changes.some(c=>c.field==='binding'));assert.ok(result.dependencies.added.includes('https://example.org/codes|2.0.0'));
});
test('FSH typed constraints preserve traceability and reject injected paths',()=>{
  const generated=constraintsToFsh([{path:'Observation.subject',min:1,source:{kind:'requirement',id:'REQ-1'}},{path:'Observation.code',binding:{strength:'required',valueSet:'https://example.org/vs'}}],'Observation');
  assert.ok(generated.lines.includes('* subject ^min = 1'));assert.equal(generated.trace[0].source.id,'REQ-1');assert.equal(generated.trace[1].source.kind,'agent-derived');
  assert.throws(()=>constraintsToFsh([{path:'subject\n* active = true'}],'Patient'));
  assert.throws(()=>constraintsToFsh([{path:'subject',min:2,max:'1'}],'Patient'));
  assert.throws(()=>constraintsToFsh([{path:'extension',extension:{canonical:'https://example.org/ext',name:'foo'}}],'Patient'),/justification/);
});
test('reuse discovery respects configured national sources and generation records exact parent',async t=>{
  const lab={resourceType:'StructureDefinition',id:'LabObservation',url:'https://test.example/national/Observation',version:'1.0.0',fhirVersion:'4.0.1',name:'LaboratoryObservation',description:'Laboratory result for research',type:'Observation',kind:'resource',derivation:'constraint',snapshot:{element:[{id:'Observation',path:'Observation'}]}};
  const ctx=await context(t,{'test.national.lab/1.0.0':await archive({name:'test.national.lab',version:'1.0.0',fhirVersions:['4.0.1']},[lab])});
  const p={...project,jurisdiction:'DE',sources:[{id:'national',url:'https://packages.fhir.org',priority:'national',jurisdiction:'DE'}],dependencies:[{id:'test.national.lab',version:'1.0.0',source:'national'}]};
  const parameters={project:p,requirement:'Laboratory result for German research',baseResource:'Observation'};
  const discovery=await execute('profile.discover',parameters,ctx);assert.equal(discovery.selectedParent,lab.url);assert.equal(discovery.recommendation,'reuse');assert.equal(discovery.reviewRequired,true);
  const generated=await execute('profile.generate',{...parameters,id:'research-lab',name:'ResearchLab',description:'Research laboratory result',constraints:[{path:'subject',min:1}]},ctx);
  assert.match(generated.fsh,/Parent: https:\/\/test.example\/national\/Observation/);assert.equal(generated.provenance.sourcePackageVersion,'1.0.0');assert.equal(generated.validation.status,'not-run');
});
test('FHIRPath executes real library with choice types and reports syntax errors',async t=>{
  const ctx=await context(t);
  const result=await execute('fhirpath.evaluate',{project,expression:'Observation.value.ofType(Quantity).value = 3.5',content:{resourceType:'Observation',valueQuantity:{value:3.5}}},ctx);
  assert.equal(result.success,true);assert.deepEqual(result.result,[true]);
  const bad=await execute('fhirpath.validate',{project,expression:'Patient.name.where('},ctx);assert.equal(bad.success,false);
  await assert.rejects(()=>execute('fhirpath.evaluate',{project,expression:'Patient.managingOrganization.resolve()',content:{resourceType:'Patient'}},ctx),/External resolution/);
});
test('invalid auth and oversized requests are rejected by the private endpoint',async t=>{
  const server=createServer({token:'t'.repeat(32)});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));const url=`http://127.0.0.1:${server.address().port}`;
  const health=await fetch(`${url}/health`);const ready=await health.json();assert.equal(health.status,ready.toolsReady?200:503);assert.equal(typeof ready.toolsReady,'boolean');
  assert.equal((await fetch(`${url}/execute`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
  const response=await fetch(`${url}/execute`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+'t'.repeat(32)},body:JSON.stringify({operation:'artifact.inspect',parameters:{project,content:{resourceType:'Patient'}}})});assert.equal(response.status,401);
});
test('tool readiness rejects a missing validator and unavailable Java',async()=>{
  const result=await checkToolReadiness({jar:'/nonexistent/fhir-validator.jar',java:'/nonexistent/java'});
  assert.equal(result.toolsReady,false);assert.ok(result.failures.includes('validator:unavailable'));assert.ok(result.failures.includes('java:requires-version-21'));
});
test('SUSHI subprocess blocks fallback network transports',()=>{
  const guard=fileURLToPath(new URL('../lib/tool-home.cjs',import.meta.url));
  const result=spawnSync(process.execPath,['--require',guard,'-e',`for (const m of ['node:http','node:https']) { for (const method of ['get','request']) { try { require(m)[method]('https://example.org'); process.exit(1); } catch (e) { if (!e.message.includes('Network access disabled')) throw e; } } } try { fetch('https://example.org'); process.exit(1); } catch(e) { if (!e.message.includes('Network access disabled')) throw e; }`],{env:{PATH:process.env.PATH,FHIR_TOOL_HOME:'/tmp/fhir-test-home'},timeout:5000});
  assert.equal(result.status,0,result.stderr?.toString());
});

test('additional exact releases allow inspection and reject uninstalled processors',async t=>{
  const ctx=await context(t),future={...project,fhirVersion:'6.0.0-snapshot1'};
  const resource={resourceType:'ImplementationGuide',id:'future',fhirVersion:['6.0.0-snapshot1']};
  assert.equal((await execute('artifact.inspect',{project:future,content:resource},ctx)).identity.resourceType,'ImplementationGuide');
  const capabilities=await execute('capabilities.get',{},ctx);
  assert.equal(capabilities.additionalExactReleases.validation,false);
  for(const operation of ['artifact.validate','profile.generate','fsh.compile','fhirpath.evaluate'])
    await assert.rejects(()=>execute(operation,{project:future,content:resource},ctx),e=>e.code==='FHIR_RELEASE_TOOLCHAIN_UNSUPPORTED');
});
test('public URL import preserves exact original bytes and refuses changed sources or patient resources',async t=>{
  const ctx=await context(t),url='https://example.org/StructureDefinition-original.json';
  let bytes=Buffer.from(' {"resourceType":"StructureDefinition","id":"original","fhirVersion":"4.0.1","copyright":"Upstream licence"}\n');
  ctx.fetchPublicDocument=async source=>({bytes,url:source});
  const inspected=await execute('source.inspect',{project,url},ctx);
  const imported=await execute('source.import',{project,url,expectedSha256:inspected.sha256},ctx);
  assert.equal(imported.content,bytes.toString());assert.equal(imported.identity.copyright,'Upstream licence');
  bytes=Buffer.from(bytes.toString().replace('original','changed'));
  await assert.rejects(()=>execute('source.import',{project,url,expectedSha256:inspected.sha256},ctx),e=>e.code==='SOURCE_CHANGED');
  bytes=Buffer.from('{"resourceType":"Patient","id":"private"}');
  await assert.rejects(()=>execute('source.inspect',{project,url},ctx),e=>e.code==='SOURCE_DEFINITION_REQUIRED');
  for(const unsafe of ['http://example.org/a','https://localhost/a','https://[::1]/a','https://[::ffff:127.0.0.1]/a','https://127.0.0.1/a','https://user:secret@example.org/a','https://example.org/a?token=secret','https://example.org:8443/a'])assert.throws(()=>publicSourceURL(unsafe));
  ctx.fetchPublicDocument=async()=>({bytes:Buffer.from('{}'),url:'https://127.0.0.1/redirect'});
  await assert.rejects(()=>execute('source.inspect',{project,url},ctx),e=>e.code==='SOURCE_DENIED');
});
test('IG URL discovers explicit publication versions and imports a pinned dependency with reuse resolution',async t=>{
  const ctx=await context(t),url='https://example.org/ig/';
  const resource={resourceType:'StructureDefinition',id:'reused',url:'https://example.org/StructureDefinition/reused',fhirVersion:'4.0.1',type:'Observation'};
  const bytes=await archive({name:'test.external',version:'1.2.0',fhirVersions:['4.0.1'],license:'CC0-1.0'},[resource]);
  let malformed=false;
  ctx.fetchPublicDocument=async source=>({url:source,bytes:source===url?Buffer.from('<html>IG</html>'):
    source.endsWith('/package-list.json') || malformed ? Buffer.from(JSON.stringify({'package-id':'test.external',list:[{version:'current',path:url,status:'ci-build'},{version:'1.2.0',path:'https://example.org/ig/1.2.0',fhirversion:'4.0.1'}]})):bytes});
  const choices=await execute('source.inspect',{project,url},ctx);assert.equal(choices.kind,'releases');assert.deepEqual(choices.releases.map(r=>r.version),['1.2.0']);
  const inspected=await execute('source.inspect',{project,url,version:'1.2.0'},ctx);assert.equal(inspected.package.license,'CC0-1.0');
  const imported=await execute('source.import',{project,url,version:'1.2.0',expectedSha256:inspected.sha256},ctx);
  assert.equal(imported.dependency.url,'https://example.org/ig/1.2.0/package.tgz');
  const configured={...project,dependencies:[imported.dependency]};
  const resolved=await execute('package.resolve',{project:configured,canonical:resource.url},ctx);assert.equal(resolved.resource.id,'reused');
  malformed=true;
  await assert.rejects(()=>execute('source.inspect',{project,url,version:'1.2.0'},ctx),e=>e.code==='SOURCE_RELEASE');
});
