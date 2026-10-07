// Isolate third-party tool caches without changing the server's process environment.
const os = require('node:os');
if (!process.env.FHIR_TOOL_HOME) throw new Error('FHIR_TOOL_HOME is required');
os.homedir = () => process.env.FHIR_TOOL_HOME;
// Tools receive only the exact, verified package cache prepared by the resolver.
// No fallback downloads, remote FSH references, update probes or arbitrary URLs.
const denied = () => { throw new Error('Network access disabled in isolated FHIR tool; install exact packages first.'); };
for (const moduleName of ['node:http', 'node:https']) {
  const network = require(moduleName);
  network.request = denied;
  network.get = denied;
}
globalThis.fetch = denied;
// SUSHI's version probe can otherwise execute npm through a shell, bypassing
// the HTTP hooks. Compilation requires no nested processes.
const childProcess = require('node:child_process');
for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) childProcess[method] = denied;
require('node:module').syncBuiltinESMExports();
