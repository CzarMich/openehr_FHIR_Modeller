import { EngineError, fail, projectConfig, tenantRoot } from './lib/common.mjs';
import { packageOperation } from './lib/packages.mjs';
import { inspectArtifact, semanticDiff } from './lib/artifacts.mjs';
import { discover, generate, analyseMapping } from './lib/modelling.mjs';
import { compile, validate, fhirpathOperation } from './lib/tooling.mjs';
import { generateExample } from './lib/examples.mjs';

export const OPERATIONS=['package.search','package.get','package.install','package.dependencies','package.artifacts','package.resolve','artifact.inspect','artifact.diff','artifact.validate','profile.discover','profile.generate','fsh.compile','fhirpath.validate','fhirpath.evaluate','mapping.analyse','examples.generate'];
export async function execute(operation,parameters={},context={}) {
  if(!OPERATIONS.includes(operation))fail('OPERATION','Unsupported FHIR engine operation.',404);
  if(!parameters||typeof parameters!=='object'||Array.isArray(parameters))fail('PARAMETERS','Parameters must be an object.');
  await tenantRoot(context);
  const project=projectConfig(parameters.project);
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
