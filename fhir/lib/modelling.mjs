import { artifactSearch, resolveArtifact } from './packages.mjs';
import { parseResource, canonical, fail, sha256, canonicalJSON, references } from './common.mjs';

const priorities={project:500,organisation:400,national:300,international:200,base:100};
const identifier=(value,label='identifier')=>{ if(typeof value!=='string'||!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value))fail('IDENTIFIER',`Invalid ${label}.`);return value; };
const string=value=>JSON.stringify(String(value));
function lexical(requirement,artifact) {
  const words=[...new Set(requirement.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu)||[])];
  const text=[artifact.name,artifact.title,artifact.description,artifact.id].filter(Boolean).join(' ').toLowerCase();
  const matched=words.filter(w=>text.includes(w));
  return {matched,score:matched.length * 8};
}
export async function discover(parameters,project,context) {
  if(typeof parameters.requirement !== 'string' || !parameters.requirement.trim() || parameters.requirement.length>10000) fail('REQUIREMENT', 'Preserve a non-empty modelling requirement of at most 10,000 characters.');
  const base=identifier(parameters.baseResource,'base resource');
  const found=await artifactSearch({resourceType:'StructureDefinition',baseResource:base,limit:1000},project,context);
  const local=(parameters.projectArtifacts || []).map(input=>parseResource(input,project.fhirVersion)).filter(r=>r.resourceType==='StructureDefinition'&&r.type===base).map(r=>({...r,package:project.packageId,packageVersion:project.version,source:'project',local:true}));
  const candidates=[...local,...found.items].map(a=> {
    const dependency=project.dependencies.find(d=>d.id===a.package);
    const source=project.sources.find(s=>s.id===dependency?.source||s.url===a.source);
    const tier=a.local?'project':source?.priority || dependency?.priority || (a.package.startsWith('hl7.fhir.r')?'base':'international');
    const priority=Number.isFinite(Number(tier)) ? Math.max(0,Math.min(600,Number(tier))) : priorities[tier] || 200;
    const relevance=lexical(parameters.requirement,a);
    const jurisdiction=Boolean(project.jurisdiction && [source?.jurisdiction,a.jurisdiction,dependency?.jurisdiction].some(j=>j&&String(j).includes(project.jurisdiction)));
    const used=(project.usedProfiles || []).includes(a.url);
    const score=priority+relevance.score+(jurisdiction?20:0)+(used?10:0)+(a.derivation==='constraint'?5:0);
    return {...a,score,relevance:{kind:'lexical-candidate-ranking; clinical semantics require review',matched:relevance.matched},compatibility:project.fhirVersion,ranking:{sourceTier:tier,sourcePriority:priority,jurisdictionMatch:jurisdiction,existingProjectUse:used},reason:[`source priority ${priority}`,`${relevance.matched.length} requirement terms matched`,jurisdiction?'project jurisdiction matches':'jurisdiction not established',`FHIR ${project.fhirVersion}`]};
  }).sort((a,b)=>b.score-a.score||String(a.url).localeCompare(String(b.url)));
  const selected=candidates[0] || null;
  const constraints=parameters.constraints || [];
  const warnings=['Candidate ranking is an inspectable discovery aid. Clinical equivalence and complete requirement coverage require human review.'];
  for(const source of project.sources.filter(s=>s.priority==='national')) if(!candidates.some(c=>c.ranking.sourceTier==='national' && (c.source===source.url || project.dependencies.some(d=>d.id===c.package&&d.source===source.id))))warnings.push(`No ${base} candidate found in configured national source ${source.id}; fallback candidates are shown.`);
  const recommendation=!selected?'unresolved':constraints.length?'derive':'reuse';
  return {requirement:parameters.requirement,baseResource:base,fhirVersion:project.fhirVersion,candidates,total:candidates.length,recommendation,selectedParent:selected?.url || null,requiredAdditionalConstraints:constraints,terminology:[...new Set(candidates.flatMap(c=>(c.references || references(c)).filter(x=>/ValueSet|CodeSystem/.test(x))))],warnings,reviewRequired:true,lock:found.lock,discoveryId:sha256(canonicalJSON({requirement:parameters.requirement,base,constraints,lock:found.lock,candidates:candidates.map(c=>[c.url,c.version,c.score])}))};
}
function pathFor(value,base) {
  if(typeof value!=='string'||value.length>300||!/^[A-Za-z][A-Za-z0-9_.\[\]:-]*$/.test(value))fail('CONSTRAINT_PATH','Invalid FSH element path.');
  return value.startsWith(`${base}.`)?value.slice(base.length+1):value;
}
function scalar(value) {
  if(typeof value==='string')return string(value);
  if(typeof value==='number'&&Number.isFinite(value)||typeof value==='boolean')return String(value);
  fail('CONSTRAINT_VALUE','FSH primitive assignment requires a string, finite number or boolean.');
}
function caretAssignments(prefix,value) {
  if(Array.isArray(value))return value.flatMap((v,i)=>caretAssignments(`${prefix}[${i}]`,v));
  if(value&&typeof value==='object')return Object.entries(value).flatMap(([k,v])=>{identifier(k,'value property');return caretAssignments(`${prefix}.${k}`,v);});
  return [`* ${prefix} = ${scalar(value)}`];
}
export function constraintsToFsh(constraints,base) {
  if(!Array.isArray(constraints)||constraints.length>500)fail('CONSTRAINTS','Supply at most 500 typed constraints.');
  const lines=[],invariants=[],trace=[];
  for(const c of constraints) {
    const p=pathFor(c.path,base);
    const allowed=new Set(['path','min','max','type','types','targetProfile','binding','mustSupport','isModifier','fixed','pattern','slicing','slices','invariant','extension','source','explanation']);
    if(Object.keys(c).some(k=>!allowed.has(k)))fail('CONSTRAINT_FIELD','Unsupported typed constraint field.');
    if(c.min!==undefined||c.max!==undefined) {
      if(c.min!==undefined&&(!Number.isInteger(c.min)||c.min<0))fail('CARDINALITY','Minimum cardinality must be a non-negative integer.');
      if(c.max!==undefined&&!/^(\*|\d+)$/.test(String(c.max)))fail('CARDINALITY','Maximum cardinality must be a non-negative integer or *.');
      if(c.min!==undefined&&c.max!==undefined&&c.max!=='*'&&Number(c.max)<c.min)fail('CARDINALITY','Maximum cardinality cannot be below minimum.');
      // Caret assignments preserve the parent's unspecified cardinality; no implicit widening.
      if(c.min!==undefined)lines.push(`* ${p} ^min = ${c.min}`);
      if(c.max!==undefined)lines.push(`* ${p} ^max = ${string(c.max)}`);
    }
    const types=c.types || (c.type?[c.type]:null);
    if(types) { if(!Array.isArray(types)||!types.length)fail('TYPE','Constraint types must be a non-empty list.'); lines.push(`* ${p} only ${types.map(t=>identifier(t,'FHIR datatype')).join(' or ')}`); }
    if(c.targetProfile) { const targets=Array.isArray(c.targetProfile)?c.targetProfile:[c.targetProfile]; lines.push(`* ${p} only Reference(${targets.map(t=>canonical(t)).join(' or ')})`); }
    if(c.mustSupport!==undefined) {if(typeof c.mustSupport!=='boolean')fail('BOOLEAN','mustSupport must be boolean.');lines.push(`* ${p} ^mustSupport = ${c.mustSupport}`);}
    if(c.isModifier!==undefined) {if(typeof c.isModifier!=='boolean')fail('BOOLEAN','isModifier must be boolean.');lines.push(`* ${p} ^isModifier = ${c.isModifier}`);}
    if(c.binding) {if(!['required','extensible','preferred','example'].includes(c.binding.strength))fail('BINDING','Invalid terminology binding strength.');lines.push(`* ${p} from ${canonical(c.binding.valueSet)} (${c.binding.strength})`);}
    for(const field of ['fixed','pattern'])if(c[field]) {const {type,value}=c[field];identifier(type,'fixed/pattern datatype');lines.push(...caretAssignments(`${p} ^${field}${type[0].toUpperCase()+type.slice(1)}`,value));}
    if(c.slicing) {
      if(!['closed','open','openAtEnd'].includes(c.slicing.rules))fail('SLICING','Slicing requires explicit rules.');
      lines.push(`* ${p} ^slicing.rules = #${c.slicing.rules}`);
      if(c.slicing.ordered!==undefined)lines.push(`* ${p} ^slicing.ordered = ${Boolean(c.slicing.ordered)}`);
      for(const [i,d]of(c.slicing.discriminators || []).entries()) {if(!['value','exists','pattern','type','profile','position'].includes(d.type))fail('SLICING','Invalid slicing discriminator.');lines.push(`* ${p} ^slicing.discriminator[${i}].type = #${d.type}`,`* ${p} ^slicing.discriminator[${i}].path = ${string(d.path)}`);}
    }
    if(c.slices)for(const s of c.slices) {identifier(s.name,'slice name');if(!Number.isInteger(s.min)||s.min<0||!/^(\*|\d+)$/.test(String(s.max)))fail('SLICING','Slice requires explicit valid cardinality.');lines.push(`* ${p} contains ${s.name} ${s.min}..${s.max}`);}
    if(c.extension) {if(!c.extension.justification)fail('EXTENSION_JUSTIFICATION','Extension use requires explicit justification and reuse analysis.');identifier(c.extension.name,'extension slice');lines.push(`* ${p} contains ${canonical(c.extension.canonical)} named ${c.extension.name} ${c.min || 0}..${c.max || '*'}`);}
    if(c.invariant) {const v=c.invariant;identifier(v.key,'invariant key');if(!['error','warning'].includes(v.severity)||typeof v.expression!=='string'||!v.human)fail('INVARIANT','Invariant needs severity, human description and FHIRPath expression.');invariants.push(`Invariant: ${v.key}\nDescription: ${string(v.human)}\nSeverity: #${v.severity}\nExpression: ${string(v.expression)}\n`);lines.push(`* ${p} obeys ${v.key}`);}
    trace.push({path:`${base}.${p}`,constraint:c,source:c.source || {kind:'agent-derived',reviewRequired:true},explanation:c.explanation || null});
  }
  return {lines,invariants,trace};
}
export async function generate(parameters,project,context) {
  if(!project.canonical||!project.packageId||!project.version)fail('PROJECT_CONFIG','Generation requires canonical, packageId and version.');canonical(project.canonical);
  const reuse=await discover(parameters,project,context);
  if(!reuse.selectedParent)fail('PARENT_UNRESOLVED','No authoritative parent found; install compatible source packages.');
  if(reuse.recommendation==='reuse'&&!parameters.derivationJustification)return {reuse,files:[],generationSkipped:'No additional constraints justify a new profile. Review the authoritative reuse candidate.',validation:{status:'not-run'}};
  const parent=parameters.parentCanonical || reuse.selectedParent;
  if(!reuse.candidates.some(c=>c.url===parent))fail('PARENT_UNRESOLVED','Chosen parent was not found in compatible configured sources.');
  if(parent!==reuse.selectedParent&&!parameters.parentRationale)fail('PARENT_RATIONALE','Explain why the chosen parent supersedes the highest ranked reuse candidate.');
  const candidate=reuse.candidates.find(c=>c.url===parent);
  const parentResource=candidate.local?parseResource((parameters.projectArtifacts || []).find(r=>r.url===parent),project.fhirVersion):(await resolveArtifact({canonical:parent,id:candidate.package},project,context)).resource;
  const id=identifier(parameters.id,'profile ID'),name=identifier(parameters.name || parameters.id,'FSH name');
  if(!parameters.description)fail('DESCRIPTION','A profile description is required.');
  const typed=constraintsToFsh(parameters.constraints || [],parameters.baseResource);
  const fields=[`Profile: ${name}`,`Parent: ${parent}`,`Id: ${id}`,`Title: ${string(parameters.title || name)}`,`Description: ${string(parameters.description)}`,`* ^version = ${string(project.version)}`,`* ^status = #draft`];
  const fsh=[...fields,...typed.lines,'',...typed.invariants].join('\n')+'\n';
  const provenance={standard:'FHIR',fhirVersion:project.fhirVersion,requirements:parameters.requirement,generatedAt:new Date().toISOString(),author:context.actor || context.tenant,baseResource:parameters.baseResource,baseProfile:parent,sourcePackage:candidate.package,sourcePackageVersion:candidate.packageVersion,parentHash:sha256(canonicalJSON(parentResource)),parentRationale:parameters.parentRationale || 'Highest ranked configured authoritative candidate, subject to human clinical review.',dependencies:reuse.lock,discoveryId:reuse.discoveryId,constraints:typed.trace,sourceKind:'generated-FSH',validation:{status:'not-run'},clinicalReview:'required'};
  return {fsh,files:[{path:`input/fsh/${id}.fsh`,content:fsh}],canonical:`${project.canonical.replace(/\/$/,'')}/StructureDefinition/${id}`,reuse,provenance,validation:{status:'not-run'},note:'Generated FSH must pass SUSHI and the FHIR validator. Discovery does not establish clinical equivalence.'};
}
export async function analyseMapping(parameters,project,context) {
  const source=parameters.source;
  if(!source||typeof source!=='object'||!Array.isArray(source.elements)||source.elements.length>500)fail('MAPPING_SOURCE','Supply an inspected source artifact with elements, paths, types and terminology; raw conversion is not supported.');
  if(!source.artifact||!source.version)fail('MAPPING_SOURCE','Source artifact and source version are required.');
  const discovery=await discover({requirement:parameters.requirement || source.description || source.artifact,baseResource:parameters.baseResource,projectArtifacts:parameters.projectArtifacts},project,context);
  const relationships=['equivalent','narrower','broader','transformed','conditional','no-direct-equivalent'];
  const proposals=(parameters.mappings || source.elements.map(e=>({sourcePath:e.path,relationship:'no-direct-equivalent'}))).map(m=>{
    if(!source.elements.some(e=>e.path===m.sourcePath))fail('MAPPING_PATH','Mapping source path is absent from inspected source.');
    if(!relationships.includes(m.relationship))fail('MAPPING_RELATIONSHIP','Invalid mapping relationship.');
    if(m.relationship==='equivalent'&&!m.justification)fail('MAPPING_EQUIVALENCE','Equivalence requires explicit semantic justification; field-name similarity is insufficient.');
    return {sourceArtifact:source.artifact,sourceVersion:source.version,sourcePath:m.sourcePath,targetArtifact:m.targetArtifact || discovery.selectedParent,targetVersion:m.targetVersion || discovery.candidates[0]?.version || null,targetPath:m.targetPath || null,relationship:m.relationship,transformation:m.transformation || null,terminologyMapping:m.terminologyMapping || null,justification:m.justification || null,status:'proposed',validation:{status:'not-run'},provenance:{source:'explicit mapping proposal; agent interpretation',author:context.actor || context.tenant,fhirVersion:project.fhirVersion,discoveryId:discovery.discoveryId}};
  });
  return {direction:parameters.direction || 'openEHR-to-FHIR',discovery,proposals,semanticGaps:source.elements.filter(e=>!proposals.some(p=>p.sourcePath===e.path&&p.targetPath)).map(e=>({path:e.path,type:e.type,cardinality:e.cardinality,terminology:e.terminology,reason:'No reviewed target element correspondence established.'})),losslessEquivalence:false,sourceModified:false};
}
