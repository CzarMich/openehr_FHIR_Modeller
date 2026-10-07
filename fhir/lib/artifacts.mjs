import { parseResource, references, canonicalJSON, sha256, fail } from './common.mjs';

export function inspectArtifact(content, version) {
  const resource = parseResource(content, version);
  const elements = resource.snapshot?.element || resource.differential?.element || [];
  const kind = resource.resourceType === 'StructureDefinition' ? (resource.type === 'Extension' ? 'Extension' : resource.kind === 'logical' ? 'LogicalModel' : resource.derivation === 'constraint' ? 'Profile' : 'StructureDefinition') : resource.resourceType;
  return { standard:'FHIR', kind, resource, identity:{resourceType:resource.resourceType,id:resource.id || null,canonical:resource.url || null,version:resource.version || null,fhirVersion:resource.fhirVersion || version || null}, elementRepresentation:resource.snapshot ? 'snapshot' : resource.differential ? 'differential' : null, elements, terminology:elements.filter(e=>e.binding).map(e=>({path:e.id || e.path,...e.binding})), invariants:elements.flatMap(e=>(e.constraint || []).map(c=>({path:e.id || e.path,...c}))), dependencies:references(resource), sha256:sha256(canonicalJSON(resource)), validation:{status:'not-run'}, source:'authoritative-input-artifact; no clinical equivalence inferred' };
}
const levels = ['informational','compatible','potentially breaking','breaking'];
const strength = { example:0,preferred:1,extensible:2,required:3 };
const asMax = v=>v === '*' ? Infinity : Number(v);
function elementKey(e) { return e.id || `${e.path}${e.sliceName ? ':'+e.sliceName : ''}`; }
function normalizedField(field,value) {
  if (['type','constraint','condition','alias','code'].includes(field) && Array.isArray(value)) return [...value].map(v=>typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k,x])=>[k,Array.isArray(x)? [...x].sort((a,b)=>canonicalJSON(a).localeCompare(canonicalJSON(b))):x])) : v).sort((a,b)=>canonicalJSON(a).localeCompare(canonicalJSON(b)));
  return value;
}
function classification(field,before,after) {
  if (field === 'min') return after > (before || 0) ? 'breaking' : 'compatible';
  if (field === 'max') return asMax(after) < asMax(before || '*') ? 'breaking' : 'compatible';
  if (field === 'type') {
    const a=new Set((before || []).map(t=>t.code)); const b=new Set((after || []).map(t=>t.code));
    if ([...a].some(t=>!b.has(t))) return 'breaking';
    if (canonicalJSON((before || []).map(t=>[t.profile,t.targetProfile])) !== canonicalJSON((after || []).map(t=>[t.profile,t.targetProfile]))) return 'potentially breaking';
    return 'compatible';
  }
  if (field === 'binding') return (strength[after?.strength] || 0) > (strength[before?.strength] || 0) ? 'breaking' : 'potentially breaking';
  if (field.startsWith('fixed') || field.startsWith('pattern') || field === 'isModifier') return 'breaking';
  if (['slicing','sliceName','constraint','condition','mustSupport','contentReference'].includes(field)) return 'potentially breaking';
  return 'informational';
}
export function semanticDiff(beforeInput, afterInput, version, dependents = []) {
  const before=parseResource(beforeInput,version), after=parseResource(afterInput,version);
  if (before.resourceType !== after.resourceType) fail('DIFF_TYPE', 'Semantic comparison requires the same FHIR resource type.');
  const changes=[]; const add=(path,field,a,b,impact)=>changes.push({path,field,before:a ?? null,after:b ?? null,classification:impact});
  const bothSnapshots=Boolean(before.snapshot?.element && after.snapshot?.element);
  const elementsA=before[bothSnapshots?'snapshot':'differential']?.element || before.snapshot?.element || [];
  const elementsB=after[bothSnapshots?'snapshot':'differential']?.element || after.snapshot?.element || [];
  const aMap=new Map(elementsA.map(e=>[elementKey(e),e])), bMap=new Map(elementsB.map(e=>[elementKey(e),e]));
  for (const key of new Set([...aMap.keys(),...bMap.keys()])) {
    const a=aMap.get(key),b=bMap.get(key);
    if (!a || !b) { add(key,'element',a,b,bothSnapshots ? (b && !b.min ? 'compatible':'breaking'):'potentially breaking'); continue; }
    const fields=new Set([...Object.keys(a),...Object.keys(b)]);
    for (const field of fields) {
      if (['id','path'].includes(field)) continue;
      if (canonicalJSON(normalizedField(field,a[field])) !== canonicalJSON(normalizedField(field,b[field]))) add(key,field,a[field],b[field],classification(field,a[field],b[field]));
    }
  }
  const ignored=new Set(['snapshot','differential','text','meta']);
  for (const field of new Set([...Object.keys(before),...Object.keys(after)])) {
    if (ignored.has(field) || canonicalJSON(before[field]) === canonicalJSON(after[field])) continue;
    const impact=['baseDefinition','type','kind','derivation','url'].includes(field) ? 'breaking' : ['compose','concept','filter','property','content','supplements','group'].includes(field) ? 'potentially breaking':'informational';
    add(before.url || before.id || before.resourceType,field,before[field],after[field],impact);
  }
  const aRefs=references(before),bRefs=references(after);
  const dependencies={added:bRefs.filter(x=>!aRefs.includes(x)),removed:aRefs.filter(x=>!bRefs.includes(x))};
  if (dependencies.added.length || dependencies.removed.length) add('$','canonicalDependencies',aRefs,bRefs,'potentially breaking');
  const impacted=[]; const changed=new Set([before.url,after.url].filter(Boolean));
  let progress=true;
  while(progress) { progress=false; for(const input of dependents) { const r=parseResource(input,version); const identity=r.url || `${r.resourceType}/${r.id}`; if(impacted.some(i=>i.artifact===identity)) continue; const refs=references(r).filter(x=>changed.has(x.split('|')[0])); if(refs.length) { impacted.push({artifact:identity,version:r.version || null,references:refs,action:'revalidate-and-review',automaticRewrite:false}); if(r.url)changed.add(r.url); progress=true; } } }
  return {resourceType:before.resourceType,comparison:bothSnapshots?'effective snapshots':'declared constraints; inherited omissions are not resolved',changes,classification:changes.reduce((value,c)=>levels.indexOf(c.classification)>levels.indexOf(value)?c.classification:value,'informational'),dependencies,impact:impacted,warnings:bothSnapshots?[]:['Differential-only changes require resolved snapshots before asserting complete compatibility.'],clinicalEquivalence:'not-established'};
}
