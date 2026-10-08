import { EngineError, fail, projectConfig, tenantRoot, RELEASES } from './lib/common.mjs';
import { packageOperation } from './lib/packages.mjs';
import { inspectArtifact, semanticDiff } from './lib/artifacts.mjs';
import { discover, generate, analyseMapping } from './lib/modelling.mjs';
import { compile, validate, fhirpathOperation } from './lib/tooling.mjs';
import { generateExample } from './lib/examples.mjs';
import {sourceOperation} from './lib/sources.mjs';

export const OPERATIONS=['capabilities.get','source.inspect','source.import','package.search','package.get','package.install','package.dependencies','package.artifacts','package.resolve','artifact.inspect','artifact.diff','artifact.validate','profile.discover','profile.generate','fsh.compile','fhirpath.validate','fhirpath.evaluate','mapping.analyse','examples.generate'];
export async function execute(operation,parameters={},context={}) {
  if(!OPERATIONS.includes(operation))fail('OPERATION','Unsupported FHIR engine operation.',404);
  if(!parameters||typeof parameters!=='object'||Array.isArray(parameters))fail('PARAMETERS','Parameters must be an object.');
  await tenantRoot(context);
  if(operation==='capabilities.get')return {toolchainReleases:Object.entries(RELEASES).map(([label,version])=>({label,version,inspection:true,compilation:true,validation:true,fhirpath:true})),
    additionalExactReleases:{inspection:true,compilation:false,validation:false,fhirpath:false},note:'Inspection does not establish conformance. Additional processors require release-specific verification.'};
  const project=projectConfig(parameters.project);
  if(!Object.values(RELEASES).includes(project.fhirVersion) && !operation.startsWith('package.') && !operation.startsWith('source.') && !['artifact.inspect','artifact.diff'].includes(operation))
    fail('FHIR_RELEASE_TOOLCHAIN_UNSUPPORTED','This exact release supports definition inspection only; no compatible authoring/validation processor is installed.',422);
  if(operation.startsWith('source.'))return sourceOperation(operation,parameters,project,context);
  if(operation.startsWith('package.'))return packageOperation(operation,parameters,project,context);
  if(operation==='artifact.inspect')return inspectArtifact(parameters.content,project.fhirVersion);
  if(operation==='artifact.diff')return semanticDiff(parameters.before,parameters.after,project.fhirVersion,parameters.dependents || []);
  if(operation==='artifact.validate')return validate(parameters,project,context);
  if(operation==='profile.discover')return discover(parameters,project,context);
  if(operation==='profile.generate')return generate(parameters,project,context);
  if(operation==='fsh.compile')return compile(parameters,project,context);
  if(operation.startsWith('fhirpath.'))return fhirpathOperation(operation,parameters,project,context);
  if(operation==='mapping.analyse')return analyseMapping(parameters,project,context);
  if(operation==='examples.generate')return generateExample(parameters,project);
}
export { EngineError };
