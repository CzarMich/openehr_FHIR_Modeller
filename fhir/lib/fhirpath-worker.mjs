import { parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
globalThis.fetch=()=>{throw Error('Network access is disabled in the FHIRPath evaluator.');};
try {
  const fhirpath=require('fhirpath');
  const name={'4.0.1':'r4','4.3.0':'r4b','5.0.0':'r5'}[workerData.version];
  let model;
  if(workerData.modelDir) {
    const {updateWithGeneratedData,arrToHash}=require('../node_modules/fhirpath/fhir-context/general-additions.js');
    model={version:'r4b',score:{extensionURI:[]}};
    for(const field of ['choiceTypePaths','pathsDefinedElsewhere','type2Parent','path2Type','path2Repeating','resourcesWithUrlParam']) {
      const data=require(`${workerData.modelDir}/${field}.json`);
      model[field]=['path2Repeating','resourcesWithUrlParam'].includes(field)?arrToHash(data):data;
    }
    updateWithGeneratedData(model);
  } else try {model=require(`fhirpath/fhir-context/${name}`);} catch {throw Error(`FHIRPath model for ${workerData.version} is unavailable in the pinned library; no release substitution was made.`);}
  // No FHIR/terminology URL or asynchronous resolver is supplied. The worker never performs network operations.
  const options={async:false,traceFn:()=>{}};
  if(workerData.operation==='fhirpath.validate') {fhirpath.compile(workerData.expression,model,options);parentPort.postMessage({success:true,syntaxValid:true,evaluated:false});}
  else {const result=fhirpath.evaluate(workerData.resource,workerData.expression,workerData.variables || {},model,options);parentPort.postMessage({success:true,result,invariantSatisfied:result.length===1&&result[0]===true});}
} catch(error) {parentPort.postMessage({success:false,diagnostics:[{severity:'error',message:error.message}]});}
