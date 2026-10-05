import https from 'node:https';
import fs from 'node:fs';
const part = (name, type, value) => ({name, ['value' + type]: value});
const parameters = (...parameter) => ({resourceType: 'Parameters', parameter});
const system = 'https://example.org/cs', set = 'https://example.org/vs', map = 'https://example.org/map';
const coding = {system, code: 'x', version: 'cs-7', display: 'Example'};
const resources = {
  CodeSystem: {resourceType: 'CodeSystem', url: system, version: 'cs-7', status: 'draft', content: 'complete', concept: [{code: 'x', display: 'Example'}]},
  ValueSet: {resourceType: 'ValueSet', url: set, version: 'vs-3', status: 'draft'},
  ConceptMap: {resourceType: 'ConceptMap', url: map, version: 'map-2', status: 'draft'},
};
https.createServer({key: fs.readFileSync('/fixture-data/tls.key'), cert: fs.readFileSync('/fixture-data/tls.crt')}, (req, res) => {
  const url = new URL(req.url, 'https://terminology-fixture');
  const q = url.searchParams;
  const send = (status, data) => { res.writeHead(status, {'Content-Type': 'application/fhir+json'}); res.end(JSON.stringify(data)); };
  if (req.method !== 'GET' || req.headers['x-api-key'] !== 'fixture-terminology-key') return send(401, {resourceType: 'OperationOutcome'});
  const path = url.pathname.replace('/fhir/', '');
  if (path === 'metadata') return send(200, {resourceType: 'CapabilityStatement', status: 'active', kind: 'instance', fhirVersion: '4.0.1', format: ['json']});
  if (path in resources) {
    const resource = resources[path];
    const matches = (!q.has('url') || q.get('url') === resource.url) && (!q.has('version') || q.get('version') === resource.version);
    return send(200, {resourceType: 'Bundle', type: 'searchset', total: matches ? 1 : 0, entry: matches ? [{resource}] : []});
  }
  if (path === 'CodeSystem/$lookup') {
    if (q.get('system') !== system || q.get('code') !== 'x') return send(404, {resourceType: 'OperationOutcome'});
    return send(200, parameters(part('display', 'String', 'Example'), part('version', 'String', 'cs-7'),
      {name: 'designation', part: [part('language', 'Code', 'de'), part('value', 'String', 'Beispiel')]},
      {name: 'designation', part: [part('language', 'Code', 'en'), part('value', 'String', 'Example')]}));
  }
  if (path === 'CodeSystem/$validate-code') return send(200, parameters(part('result', 'Boolean', q.get('url') === system && q.get('code') === 'x')));
  if (path === 'ValueSet/$validate-code') {
    if (q.get('valueSetVersion') !== 'vs-3' || q.get('systemVersion') !== 'cs-7') return send(400, {resourceType: 'OperationOutcome'});
    return send(200, parameters(part('result', 'Boolean', q.get('url') === set && q.get('system') === system && q.get('code') === 'x'),
      part('valueSetVersion', 'String', 'vs-3'), part('systemVersion', 'String', 'cs-7')));
  }
  if (path === 'ValueSet/$expand') {
    if (q.get('url') !== set || q.get('includeDesignations') !== 'true' || q.get('excludeNested') !== 'true') return send(400, {resourceType: 'OperationOutcome'});
    const offset = Number(q.get('offset') || 0), count = Number(q.get('count') || 0);
    return send(200, {...resources.ValueSet, expansion: {identifier: 'urn:uuid:61185f5a-425f-4df2-bd6c-b88fe944c24c', timestamp: new Date().toISOString(), total: 1, offset, contains: offset === 0 && count > 0 ? [coding] : []}});
  }
  if (path === 'ConceptMap/$translate') {
    if (q.get('url') !== map || q.get('conceptMapVersion') !== 'map-2' || q.get('version') !== 'cs-7') return send(400, {resourceType: 'OperationOutcome'});
    return send(200, parameters(part('result', 'Boolean', true), {name: 'match', part: [part('equivalence', 'Code', 'equivalent'),
      part('concept', 'Coding', {system: 'https://example.org/target', code: 'y', display: 'Synthetic target'}), part('source', 'Uri', map)]}));
  }
  return send(404, {resourceType: 'OperationOutcome'});
}).listen(443, () => fs.writeFileSync('/fixture-data/ready', 'ready'));
