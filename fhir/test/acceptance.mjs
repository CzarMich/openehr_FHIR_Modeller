// Real-tool acceptance. This never publishes, writes to a runtime FHIR server,
// or treats the synthetic evidence as clinical approval.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { stringify } from 'yaml';
import { execute } from '../engine.mjs';
import { sha256 } from '../lib/common.mjs';

const base=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out=process.env.FHIR_ACCEPTANCE_EXPORT || path.join(base,'acceptance-export');
const context={tenant:'development-acceptance',dataDir:process.env.FHIR_DATA_DIR || path.join(base,'.data')};
// An operator may preload byte-for-byte registry archives when Dev has restricted
// egress. Runtime HTTP callers cannot inject this transport or a filesystem path.
if(process.env.FHIR_ACCEPTANCE_PACKAGES)context.fetchBuffer=async url=>{
  const parsed=new URL(url),parts=parsed.pathname.split('/').filter(Boolean);
  assert.equal(parsed.origin,'https://packages.fhir.org');assert.equal(parts.length,2);
  return readFile(path.join(process.env.FHIR_ACCEPTANCE_PACKAGES,`${parts[0]}#${parts[1]}.tgz`));
};
const project={name:'HYQDevelopmentPatient',fhirVersion:'4.0.1',canonical:'https://example.org/hyq/dev/fhir',packageId:'org.hyq.dev.acceptance',version:'0.1.0',publisher:'HYQ development testing',jurisdiction:'',language:'en',dependencies:[],sources:[]};
const evidence={environment:'development',synthetic:true,clinicalApproval:false,distributionAuthority:'Existing HYQ FHIR Governance Platform',startedAt:new Date().toISOString(),project,checks:[]};
async function save(name,value){const file=path.join(out,name);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,typeof value==='string'?value:JSON.stringify(value,null,2)+'\n');}
async function check(name,action){const started=Date.now();console.log(`Acceptance: ${name}`);const result=await action();evidence.checks.push({name,success:true,elapsedMs:Date.now()-started});return result;}
try {
  const generated=await check('author from authoritative R4 Patient parent',async()=>{
    const result=await execute('profile.generate',{project,requirement:'Synthetic development patient must explicitly be active and have a birth date.',baseResource:'Patient',id:'hyq-dev-patient',name:'HYQDevelopmentPatient',title:'HYQ development Patient',description:'Synthetic profile used to test the authoring, validation and Git-to-IG draft workflow. Not for clinical use.',constraints:[{path:'Patient.active',min:1,fixed:{type:'boolean',value:true},source:{kind:'requirement',id:'DEV-REQ-1'}},{path:'Patient.birthDate',min:1,source:{kind:'requirement',id:'DEV-REQ-2'}}]},context);
    assert.match(result.fsh,/Parent:/);return result;
  });
  await save('input/fsh/hyq-dev-patient.fsh',generated.fsh);
  await save('sushi-config.yaml',stringify({id:project.packageId,canonical:project.canonical,name:project.name,status:'draft',version:project.version,fhirVersion:project.fhirVersion,FSHOnly:true}));
  await save('provenance/generation.json',generated);
  const compiled=await check('SUSHI produces StructureDefinition with snapshot',async()=>{
    const result=await execute('fsh.compile',{project,files:[{path:'input/fsh/hyq-dev-patient.fsh',content:generated.fsh}]},context);
    await save('validation/sushi.json',result);
    assert.equal(result.success,true,JSON.stringify(result.diagnostics));return result;
  });
  for(const file of compiled.files)await save(file.path,file.content);
  const profile=compiled.files.map(f=>JSON.parse(f.content)).find(r=>r.resourceType==='StructureDefinition'&&r.id==='hyq-dev-patient');
  assert.ok(profile?.snapshot?.element?.length);
  await check('generated StructureDefinition passes actual HL7 validator',async()=>{
    const result=await execute('artifact.validate',{project,content:profile},context);await save('validation/profile.json',result);assert.equal(result.valid,true,JSON.stringify(result.issues));
  });
  const good={resourceType:'Patient',id:'synthetic-dev-patient',meta:{profile:[profile.url]},text:{status:'generated',div:'<div xmlns="http://www.w3.org/1999/xhtml">Synthetic development patient. Not for clinical use.</div>'},active:true,birthDate:'2000-01-01'};
  const bad={...good,id:'synthetic-invalid-patient',active:false};delete bad.birthDate;
  await save('input/examples/Patient-synthetic-dev-patient.json',good);
  // Intentionally invalid fixtures never live in the server import directory.
  await save('tests/invalid/Patient-synthetic-invalid-patient.json',bad);
  await check('synthetic conforming example passes target profile',async()=>{
    const result=await execute('artifact.validate',{project,content:good,profiles:[profile],profile:profile.url},context);await save('validation/example-valid.json',result);assert.equal(result.valid,true,JSON.stringify(result.issues));assert.equal(result.publicationReady,false,'offline terminology must not authorize publication');
  });
  await check('invalid example fails fixed value and required birthDate',async()=>{
    const result=await execute('artifact.validate',{project,content:bad,profiles:[profile],profile:profile.url},context);await save('validation/example-invalid.json',result);assert.equal(result.valid,false);assert.ok(result.counts.errors>=2);
  });
  await check('FHIRPath evaluates using the real R4 model',async()=>{
    const result=await execute('fhirpath.evaluate',{project,content:good,expression:'Patient.active = true and Patient.birthDate.exists()'},context);assert.equal(result.success,true);assert.deepEqual(result.result,[true]);await save('validation/fhirpath.json',result);
  });
  const changed=structuredClone(profile);changed.snapshot.element.find(e=>e.path==='Patient.name').min=1;
  await check('semantic comparison detects tighter cardinality',async()=>{const result=await execute('artifact.diff',{project,before:profile,after:changed},context);assert.equal(result.classification,'breaking');await save('validation/semantic-diff.json',result);});
  evidence.success=true;evidence.profile={canonical:profile.url,sha256:sha256(JSON.stringify(profile))};
} catch(error){evidence.success=false;evidence.failure={name:error.name,message:error.message};process.exitCode=1;console.error(error.message);}
finally{evidence.completedAt=new Date().toISOString();await save('validation/acceptance.json',evidence);console.log(JSON.stringify({success:evidence.success,checks:evidence.checks.length,output:out}));}
