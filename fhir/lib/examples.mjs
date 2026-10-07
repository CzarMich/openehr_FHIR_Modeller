import { parseResource, fail, sha256, canonicalJSON } from './common.mjs';

// This creates synthetic examples from an inspected profile. It never invents clinical codes.
export function generateExample(parameters, project) {
  const profile=parseResource(parameters.content || parameters.profile,project.fhirVersion);
  if(profile.resourceType!=='StructureDefinition'||!profile.url||!profile.type)fail('PROFILE_REQUIRED','Example generation requires a StructureDefinition with canonical and base type.');
  const id=parameters.id || `${profile.id || 'profile'}-example`;
  if(!/^[A-Za-z0-9.-]{1,64}$/.test(id))fail('EXAMPLE_ID','Invalid example ID.');
  const resource={resourceType:profile.type,id,meta:{profile:[`${profile.url}${profile.version?'|'+profile.version:''}`]}};
  const elements=profile.snapshot?.element || profile.differential?.element || [];
  const gaps=[];const supplied=parameters.values || {};
  if(!supplied||typeof supplied!=='object'||Array.isArray(supplied))fail('EXAMPLE_VALUES','Example values must map element paths to values.');
  const forbidden=new Set(['__proto__','prototype','constructor']);
  function setValue(element,value,pathOverride) {
    let parts=(pathOverride || element.path).split('.');if(parts[0]===profile.type)parts.shift();
    let current=resource;
    for(let i=0;i<parts.length;i++) {
      let part=parts[i];if(part.includes(':')){gaps.push({path:element.id || element.path,reason:'Sliced elements need an explicit reviewed example.'});return;}
      if(part.endsWith('[x]')){const types=element.type || [];if(types.length!==1){gaps.push({path:element.path,reason:'Choose one permitted datatype explicitly.'});return;}part=part.slice(0,-3)+types[0].code[0].toUpperCase()+types[0].code.slice(1);}
      const match=/^([A-Za-z][A-Za-z0-9]*)(?:\[(\d+)\])?$/.exec(part);if(!match||forbidden.has(match[1]))fail('EXAMPLE_PATH','Invalid example path.');
      const key=match[1],index=match[2]?Number(match[2]):0;if(index>100)fail('EXAMPLE_PATH','Example array index exceeds 100.');
      const prefix=profile.type+'.'+parts.slice(0,i+1).join('.').replace(/\[\d+\]/g,'');
      const definition=elements.find(e=>e.path===prefix);
      const repeats=Boolean(match[2]||definition&&(definition.max==='*'||Number(definition.max)>1));
      if(i===parts.length-1){if(repeats&&!Array.isArray(value)){current[key]||=[];current[key][index]=structuredClone(value);}else current[key]=structuredClone(value);}
      else if(repeats){current[key]||=[];current[key][index]||={};current=current[key][index];}
      else{current[key]||={};current=current[key];}
    }
  }
  const explicitPaths=new Set();
  for(const [p,v]of Object.entries(supplied)){const full=p.startsWith(profile.type+'.')?p:profile.type+'.'+p;const element=elements.find(e=>e.path===full.replace(/\[\d+\]/g,'')||e.path.replace('[x]','')===full.replace(/(?:String|Quantity|CodeableConcept|Boolean|Integer|DateTime)$/,''));if(!element)fail('EXAMPLE_PATH',`Example path ${p} is not declared in the profile snapshot/differential.`);setValue(element,v,full);explicitPaths.add(element.path);}
  for(const e of elements) {
    if(!e.path?.includes('.')||e.max==='0'||e.path.includes('.extension')||e.path.includes('.modifierExtension')||e.path.includes('.contained')||e.id?.includes(':')||explicitPaths.has(e.path))continue;
    const fixed=Object.keys(e).find(k=>/^fixed[A-Z]|^pattern[A-Z]/.test(k));
    if(fixed){setValue(e,e[fixed]);continue;}
    if(!(e.min>0))continue;
    const parents=e.path.split('.');parents.pop();let ancestorOptional=false;
    while(parents.length>1){const ancestor=elements.find(x=>x.path===parents.join('.'));if(ancestor&&!(ancestor.min>0)){ancestorOptional=true;break;}parents.pop();}
    if(ancestorOptional)continue;
    const type=e.type?.length===1?e.type[0].code:null;
    const safe={boolean:true,integer:1,positiveInt:1,unsignedInt:0,decimal:1,string:'Synthetic example',markdown:'Synthetic example',date:'2000-01-01',dateTime:'2000-01-01T00:00:00Z',instant:'2000-01-01T00:00:00Z',id:'synthetic',HumanName:{family:'Synthetic',given:['Example']},Address:{text:'Synthetic example address'}};
    if(Object.hasOwn(safe,type))setValue(e,safe[type]);
    else if(['BackboneElement','Element'].includes(type))continue;
    else gaps.push({path:e.id || e.path,type,reason:'An explicit valid value is required; clinical codes, references and units are not invented.'});
  }
  const content=JSON.stringify(resource,null,2)+'\n';
  return {resource,files:[{path:`input/examples/${id}.json`,content}],synthetic:true,gaps,validation:{status:'not-run',profile:profile.url},provenance:{sourceProfile:profile.url,sourceProfileVersion:profile.version || null,profileHash:sha256(canonicalJSON(profile)),fhirVersion:project.fhirVersion,source:'profile constraints and explicit example values; synthetic placeholders identified',generatedAt:new Date().toISOString()},warnings:[...(!profile.snapshot?['A resolved snapshot is needed to enumerate all inherited required elements.']:[]),'Validate this synthetic example against its exact profile before submission.']};
}
