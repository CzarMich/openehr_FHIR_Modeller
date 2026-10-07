import { spawn } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, rm, writeFile, readFile, readdir, cp, access } from 'node:fs/promises';
import path from 'node:path';
import { stringify } from 'yaml';
import { tenantRoot, safeFile, parseResource, sha256, fail, jsonRead, canonical, atomicJSON } from './common.mjs';
import { resolveDependencies } from './packages.mjs';
import { terminologyBridge, javaPolicy } from './terminology.mjs';

export const TOOL_VERSIONS={sushi:'3.20.1',fhirpath:'5.2.0',validator:'6.10.4'};
export const VALIDATOR_SHA256='1106b9d58f9e363e47bea7c4fc065841e5fc91fe9d062775c3bfdd212bd653cc';
const base=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
async function run(command,args,cwd,toolHome,timeout=180_000) {
  return new Promise(resolve=>{
    const started=Date.now();const child=spawn(command,args,{cwd,env:{PATH:process.env.PATH,LANG:'C.UTF-8',NODE_ENV:'production',FHIR_TOOL_HOME:toolHome},stdio:['ignore','pipe','pipe'],shell:false,detached:true});
    let stdout='',stderr='',timedOut=false,oversized=false;
    const stop=()=>{try{process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}};
    const timer=setTimeout(()=>{timedOut=true;stop();},timeout);
    const collect=target=>b=>{if(stdout.length+stderr.length>2_000_000){oversized=true;stop();return;}if(target==='out')stdout+=b.toString();else stderr+=b.toString();};
    child.stdout.on('data',collect('out'));child.stderr.on('data',collect('err'));
    child.on('error',error=>{clearTimeout(timer);resolve({exitCode:null,stdout,stderr:error.message,timedOut,elapsedMs:Date.now()-started,executed:false});});
    child.on('close',(exitCode,signal)=>{clearTimeout(timer);resolve({exitCode,signal,stdout,stderr,timedOut,oversized,elapsedMs:Date.now()-started,executed:true});});
  });
}
async function job(project,context) {
  const lock=await resolveDependencies(project,context),root=await tenantRoot(context);
  await mkdir(path.join(root,'jobs'),{recursive:true});
  const dir=await mkdtemp(path.join(root,'jobs','run-'));
  const toolHome=path.join(dir,'home'),cache=path.join(toolHome,'.fhir','packages');await mkdir(cache,{recursive:true});
  for(const p of lock.packages)await cp(path.join(root,'packages',p.key,'package'),path.join(cache,`${p.id}#${p.version}`,'package'),{recursive:true});
  return {dir,root,toolHome,lock};
}
function publicEvidence(result,dir,tool,version,inputs,lock) {
  const clean=text=>text.replaceAll(dir,'[job]').replace(/\u001b\[[0-9;]*m/g,'');
  return {tool,version,executed:result.executed,exitCode:result.exitCode,signal:result.signal || null,timedOut:result.timedOut,elapsedMs:result.elapsedMs,stdout:clean(result.stdout),stderr:clean(result.stderr),inputHashes:inputs,dependencies:lock,completedAt:new Date().toISOString()};
}
async function outputFiles(root,prefix='') {
  const files=[];let entries=[];try{entries=await readdir(path.join(root,prefix),{withFileTypes:true});}catch(e){if(e.code==='ENOENT')return [];throw e;}
  for(const e of entries){const p=path.posix.join(prefix,e.name);if(e.isDirectory())files.push(...await outputFiles(root,p));else if(e.isFile()&&p.endsWith('.json'))files.push({path:p,content:await readFile(path.join(root,p),'utf8')});}
  return files;
}
export async function compile(parameters,project,context) {
  if(!Array.isArray(parameters.files)||!parameters.files.length||parameters.files.length>200)fail('FILES','Provide 1..200 source files.');
  const paths=new Set();let size=0;
  for(const file of parameters.files){safeFile(file.path);if(paths.has(file.path))fail('DUPLICATE_FILE','Duplicate source file path.');paths.add(file.path);if(!/^input\/(fsh\/.+\.fsh|(resources|examples)\/.+\.json)$/.test(file.path))fail('SOURCE_FILE','Only input/fsh/*.fsh and input/resources or input/examples JSON are accepted.');if(typeof file.content!=='string'||(size+=Buffer.byteLength(file.content))>10_000_000)fail('FILES_SIZE','Compilation sources must be text and total at most 10 MB.');}
  const j=await job(project,context);
  try {
    const config={id:project.packageId,canonical:project.canonical,name:project.name || project.packageId,title:project.name || project.packageId,status:'draft',version:project.version,fhirVersion:project.fhirVersion,FSHOnly:true,dependencies:Object.fromEntries(project.dependencies.map(d=>[d.id,d.version]))};
    if(!config.id||!config.canonical||!config.version)fail('PROJECT_CONFIG','Compilation requires packageId, canonical and version.');
    canonical(config.canonical);
    await writeFile(path.join(j.dir,'sushi-config.yaml'),stringify(config));
    for(const file of parameters.files){const dest=path.join(j.dir,file.path);await mkdir(path.dirname(dest),{recursive:true});await writeFile(dest,file.content);}
    const args=['--require',path.join(base,'lib','tool-home.cjs'),path.join(base,'node_modules','fsh-sushi','dist','app.js'),'build',j.dir,'--snapshot','--out',path.join(j.dir,'output')];
    const result=await run(process.execPath,args,j.dir,j.toolHome,context.toolTimeout || 180_000);
    const evidence=publicEvidence(result,j.dir,'SUSHI',TOOL_VERSIONS.sushi,parameters.files.map(f=>({path:f.path,sha256:sha256(f.content)})),j.lock);
    const diagnostics=[...evidence.stdout.split('\n'),...evidence.stderr.split('\n')].filter(line=>/^\s*(error|warn)/i.test(line)).map(message=>({severity:/^\s*error/i.test(message)?'error':'warning',message}));
    const success=result.exitCode===0&&!result.timedOut&&!result.oversized&&!diagnostics.some(d=>d.severity==='error');
    const generated=success?await outputFiles(path.join(j.dir,'output')):[];
    const resourceFiles=generated.filter(f=>JSON.parse(f.content)?.resourceType);
    return {success,stage:'compile',files:resourceFiles.map(f=>({...f,path:f.path.startsWith('fsh-generated/')?f.path:`fsh-generated/${f.path}`})),diagnostics,evidence,validation:{status:'not-run',note:'SUSHI compilation is not full FHIR or terminology validation.'}};
  } finally {await rm(j.dir,{recursive:true,force:true});}
}
export async function validate(parameters,project,context) {
  const resource=parseResource(parameters.content,project.fhirVersion);
  const profiles=(parameters.profiles || []).map(p=>parseResource(p,project.fhirVersion));
  if(profiles.length>100||profiles.some(p=>p.resourceType!=='StructureDefinition'))fail('PROFILES','Provide at most 100 StructureDefinitions.');
  if(parameters.profile)canonical(parameters.profile);
  const jar=process.env.FHIR_VALIDATOR_JAR || path.join(base,'tools','validator_cli.jar');
  try {await access(jar);}catch{fail('VALIDATOR_UNAVAILABLE','Pinned HL7 validator is not installed; validation was not executed.',503);}
  const actual=sha256(await readFile(jar));if(actual!==VALIDATOR_SHA256)fail('VALIDATOR_CHECKSUM','HL7 validator checksum does not match the pinned release.',503);
  const j=await job(project,context);
  let bridge;
  try {
    const input=path.join(j.dir,'resource.json'),output=path.join(j.dir,'outcome.json');await writeFile(input,JSON.stringify(resource));
    bridge=await terminologyBridge();
    const policy=path.join(j.dir,'validator.policy');await writeFile(policy,javaPolicy(bridge?.socket));
    const args=[`-Duser.home=${j.toolHome}`,'-Djava.security.manager',`-Djava.security.policy==${policy}`,'-Xmx1536m','-jar',jar,input,'-version',project.fhirVersion,'-tx',bridge?.url || 'n/a','-output',output];
    const root=await tenantRoot(context);
    for(const p of j.lock.packages.filter(p=>!p.id.endsWith('.core')))args.push('-ig',path.join(root,'packages',p.key,'package.tgz'));
    if(profiles.length){const profileDir=path.join(j.dir,'profiles');await mkdir(profileDir);for(const [i,p]of profiles.entries())await writeFile(path.join(profileDir,`${i}.json`),JSON.stringify(p));args.push('-ig',profileDir);}
    if(parameters.profile)args.push('-profile',parameters.profile);
    const result=await run('java',args,j.dir,j.toolHome,context.toolTimeout || 300_000);
    const evidence=publicEvidence(result,j.dir,'HL7 FHIR Validator',TOOL_VERSIONS.validator,[{path:'resource.json',sha256:sha256(JSON.stringify(resource))},...profiles.map((p,i)=>({path:`profiles/${i}.json`,sha256:sha256(JSON.stringify(p))}))],j.lock);
    const outcome=await jsonRead(output,null);
    const outcomes=outcome?.resourceType==='Bundle'?outcome.entry?.map(e=>e.resource).filter(r=>r?.resourceType==='OperationOutcome') || []:outcome?.resourceType==='OperationOutcome'?[outcome]:[];
    const issues=outcomes.flatMap(o=>o.issue || []);
    const success=result.exitCode===0&&!result.timedOut&&!result.oversized&&outcomes.length>0&&!issues.some(i=>['error','fatal'].includes(i.severity));
    const terminologyUnavailable=bridge?.unavailable() || issues.some(i=>/terminology.*(unavailable|unable|not supported|not found)|unable to.*(value.?set|code.?system)|could not.*(code.?system|value.?set)|unknown.*(code.?system|value.?set)|no terminology server/i.test(JSON.stringify(i)));
    const terminology={status:bridge?(success&&!terminologyUnavailable?'valid':terminologyUnavailable?'incomplete':'failed'):'not-run',reason:bridge?'HL7 validator used the deployment-configured terminology service.':'No terminology server configured. Run terminology checks before publication.'};
    return {success,valid:success,publicationReady:success&&terminology.status==='valid',status:outcomes.length?(success?'valid':'invalid'):'not-completed',scope:bridge?'FHIR structural/profile and terminology validation':'FHIR structural/profile validation; remote terminology checking disabled',terminology,counts:{errors:issues.filter(i=>['error','fatal'].includes(i.severity)).length,warnings:issues.filter(i=>i.severity==='warning').length,information:issues.filter(i=>i.severity==='information').length},issues,outcome,evidence,artifactHash:sha256(JSON.stringify(resource)),profile:parameters.profile || null};
  } finally {if(bridge)await bridge.close();await rm(j.dir,{recursive:true,force:true});}
}
async function r4bModel(project,context) {
  const root=await tenantRoot(context),lock=await resolveDependencies(project,context);
  const core=lock.packages.find(p=>p.id==='hl7.fhir.r4b.core');
  const modelDir=path.join(root,'models',`r4b-${TOOL_VERSIONS.fhirpath}-${core.sha256}`);
  try {await access(path.join(modelDir,'complete.json'));return modelDir;}catch{}
  await mkdir(modelDir,{recursive:true});
  const definitionDir=await mkdtemp(path.join(modelDir,'source-'));
  try {
    const index=await jsonRead(path.join(root,'packages',core.key,'index.json'));
    const types=[],resources=[],search=[];
    for(const item of index.filter(i=>['StructureDefinition','SearchParameter'].includes(i.resourceType))) {
      const resource=await jsonRead(path.join(root,'packages',core.key,item.file));
      if(resource.resourceType==='SearchParameter')search.push({resource});
      else if(resource.derivation!=='constraint') (resource.kind==='resource'?resources:types).push({resource});
    }
    for(const [name,entry]of Object.entries({'profiles-types':types,'profiles-resources':resources,'profiles-others':[],'search-parameters':search}))await atomicJSON(path.join(definitionDir,`${name}.json`),{resourceType:'Bundle',entry});
    // Use the pinned library's own extractor against the exact R4B core package.
    const result=await run(process.execPath,[path.join(base,'node_modules','fhirpath','fhir-context','extract-model-info.js'),'--fhirDefDir',definitionDir,'--outputDir',modelDir],definitionDir,definitionDir,30_000);
    if(result.exitCode!==0)fail('FHIRPATH_MODEL','Unable to derive the R4B FHIRPath model from its exact core definitions.',503);
    await atomicJSON(path.join(modelDir,'complete.json'),{core,library:TOOL_VERSIONS.fhirpath});
    return modelDir;
  }finally{await rm(definitionDir,{recursive:true,force:true});}
}
export async function fhirpathOperation(operation,parameters,project,context) {
  if(typeof parameters.expression!=='string'||!parameters.expression.trim()||parameters.expression.length>10000)fail('FHIRPATH','An expression of 1..10000 characters is required.');
  // Network-enabled FHIRPath functions are deliberately not exposed in this private evaluator.
  if(/%terminologies|%server|%factory|\.resolve\s*\(/.test(parameters.expression))fail('FHIRPATH_NETWORK','External resolution is not enabled; pass resolved data explicitly.');
  const resource=operation==='fhirpath.evaluate'?parseResource(parameters.content || parameters.resource,project.fhirVersion):{};
  const modelDir=project.fhirVersion==='4.3.0'?await r4bModel(project,context):undefined;
  return new Promise((resolve,reject)=>{
    const worker=new Worker(new URL('./fhirpath-worker.mjs',import.meta.url),{workerData:{operation,expression:parameters.expression,resource,version:project.fhirVersion,modelDir,variables:parameters.variables || {}},resourceLimits:{maxOldGenerationSizeMb:128}});
    const timer=setTimeout(()=>{worker.terminate();resolve({success:false,diagnostics:[{severity:'error',message:'FHIRPath evaluation exceeded 5 seconds.'}],tool:'fhirpath.js',version:TOOL_VERSIONS.fhirpath});},5000);
    worker.once('message',result=>{clearTimeout(timer);worker.terminate();resolve({...result,tool:'fhirpath.js',version:TOOL_VERSIONS.fhirpath,fhirVersion:project.fhirVersion});});
    worker.once('error',error=>{clearTimeout(timer);reject(error);});
  });
}
