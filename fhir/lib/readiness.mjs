import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { TOOL_VERSIONS, VALIDATOR_SHA256 } from './tooling.mjs';

const base=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export async function checkToolReadiness({jar=process.env.FHIR_VALIDATOR_JAR || path.join(base,'tools','validator_cli.jar'),java='java'}={}) {
  const failures=[];
  for(const [dependency,expected]of [['fsh-sushi',TOOL_VERSIONS.sushi],['fhirpath',TOOL_VERSIONS.fhirpath]]) {
    try {const manifest=JSON.parse(await readFile(path.join(base,'node_modules',dependency,'package.json'),'utf8'));if(manifest.version!==expected)failures.push(`${dependency}:version-mismatch`);}
    catch {failures.push(`${dependency}:unavailable`);}
  }
  try {const hash=createHash('sha256');for await(const chunk of createReadStream(jar))hash.update(chunk);if(hash.digest('hex')!==VALIDATOR_SHA256)failures.push('validator:checksum-mismatch');}
  catch {failures.push('validator:unavailable');}
  try {if(!(await readFile(path.join(base,'tools','ValidationRunner.class'))).length)throw Error();}catch{failures.push('validator-runner:unavailable');}
  const runtime=spawnSync(java,['-version'],{timeout:5000,encoding:'utf8',maxBuffer:16000});
  // Java 21 retains the network policy used to confine validator subprocesses.
  if(runtime.status!==0 || !/version "21\./.test(runtime.stderr || runtime.stdout || ''))failures.push('java:requires-version-21');
  return {toolsReady:failures.length===0,failures};
}
