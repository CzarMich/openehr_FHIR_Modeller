#!/usr/bin/env python3
"""Generate the public catalogue from a real tools/list snapshot exported by mcp-smoke.py."""
import json
from pathlib import Path

catalogue = Path('docs/evidence/tool-catalogue.json')
tools = json.loads(catalogue.read_text())
examples = {
 'model_import_inspect':{'filename':'example.xml','contentBase64':'PHgvPg=='},
 'model_artifact_import':{'project':'modelling-demo','filename':'example.xml','contentBase64':'PHgvPg==','declaredType':'UNKNOWN'},
 'model_artifact_provenance':{'project':'modelling-demo','importId':'<import-id-from-receipt>'},
 'archetype_validate':{'content':'<ADL 2 source>'},
 'template_validate':{'content':'<ADL 2 template>', 'dependencies':[{'identifier':'<exact archetype identifier>','content':'<ADL 2 dependency>'}]},
 'template_compile':{'content':'<ADL 2 template>', 'dependencies':[{'identifier':'<exact archetype identifier>','content':'<ADL 2 dependency>'}]},
 'opt_validate':{'content':'<OPT 2 ADL source>'},
 'model_inspect':{'content':'<ADL 2 source>', 'format':'adl2'},
 'aql_validate':{'content':'SELECT e/ehr_id/value FROM EHR e'},
 'template_compile_project':{'project':'modelling-demo','path':'templates/fixture.adlt','revision':'<exact template revision>','dependencies':[{'identifier':'<exact archetype identifier>','path':'archetypes/composition.adls','revision':'<exact dependency revision>'}]},
 'ckm_federated_search':{'kind':'archetype','keyword':'body weight','sources':['default'],'maxResults':5},
 'ckm_sources':{}, 'ckm_archetype_search':{'keyword':'body weight','maxResults':5},
 'ckm_archetype_get':{'identifier':'openEHR-EHR-OBSERVATION.body_weight.v2','format':'adl'},
 'ckm_template_search':{'keyword':'encounter','maxResults':5},'ckm_template_get':{'identifier':'1013.26.1','format':'oet'},
 'guide_search':{'query':'cardinality'},'guide_get':{'category':'howto','name':'spec-lookup'},'guide_adl_idiom_lookup':{'pattern':'occurrences'},
 'examples_search':{'kind':'aql'},'examples_get':{'uri':'openehr://examples/aql/<name-from-search>'},
 'type_specification_search':{'namePattern':'DV_TEXT'},'type_specification_get':{'name':'DV_TEXT','component':'RM'},'terminology_resolve':{'input':'433'},
 'model_repository_info':{}, 'model_repository_branches':{'page':1},
 'model_repository_diff':{'baseRevision':'<reachable-base-sha>','headRevision':'<reachable-head-sha>'},
 'model_branch_create':{'branch':'draft/admission','baseRevision':'<reachable-base-sha>'},
 'model_review_request':{'branch':'draft/admission','title':'Review admission draft','body':'Validation evidence and unresolved findings.'},
 'model_review_get':{'number':1},
 'model_projects':{},'model_project_create':{'id':'neonatal-care','name':'Neonatal care'},'model_project_get':{'project':'neonatal-care'},
 'model_artifact_get':{'project':'neonatal-care','path':'requirements/admission.md'},
 'model_artifact_save':{'project':'neonatal-care','path':'requirements/admission.md','content':'Requirement: record birth weight.','expectedRevision':None},
 'model_artifact_history':{'project':'neonatal-care','path':'requirements/admission.md'},
 'model_requirements_coverage':{'project':'neonatal-care','requirements':[{'id':'REQ-1'}],'links':[]},
 'model_validate':{'content':'<a/>','format':'xml'},'model_diff':{'before':'<a min="0"/>','after':'<a min="1"/>'},'model_qa':{'content':'<a/>','format':'xml'},
 'template_build_oet':{'name':'Admission draft','composition':'openEHR-EHR-COMPOSITION.encounter.v1','entries':['openEHR-EHR-OBSERVATION.body_weight.v2']},
 'terminology_capabilities':{},'terminology_lookup':{'system':'http://snomed.info/sct','code':'404684003'},
 'terminology_validate_code':{'system':'http://snomed.info/sct','code':'404684003'},
 'terminology_expand':{'valueSet':'http://snomed.info/sct?fhir_vs=isa/404684003','count':2},
 'terminology_translate':{'conceptMap':'https://example.org/ConceptMap/example','system':'https://example.org/CodeSystem/source','code':'example','version':'1'},
 'terminology_resource_search':{'resourceType':'ValueSet','name':'feeding','count':10},
 'terminology_resource_get':{'resourceType':'ValueSet','canonical':'https://example.org/ValueSet/feeding','version':'1'},
 'terminology_manifest':{'artifact':'templates/admission.oet','bindings':[]},
}
catalogue_record={'kind':'code_system','canonical':'https://example.org/local/feeding','version':'1','name':'Feeding','provenance':{'source':'Organisation-authored local draft'},'concepts':[{'code':'mixed','display':'Mixed feeding'}]}
examples.update({
 'model_traceability_save':{'project':'neonatal-care','graph':{'schema':1,'nodes':[{'id':'R-023','type':'requirement','title':'Project requirement','description':'Record the actual user-supplied modelling requirement.','provenance':['Project requirements workshop notes'],'priority':'must','status':'ACTIVE'}],'edges':[]}},
 'model_project_qa':{'project':'neonatal-care','path':'templates/admission.oet'},
 'model_traceability_get':{'project':'neonatal-care'},
 'model_traceability_explain':{'project':'neonatal-care','node':'C-1'},
 'model_traceability_requirement':{'project':'neonatal-care','requirement':'R-023'},
 'governance_prepare':{'project':'neonatal-care','path':'templates/admission.oet','modelRevision':'<observed-model-revision>','comment':'Prepare this exact draft for review.'},
 'governance_validate':{'subject':'<subject-from-prepare>','expectedSequence':1},
 'governance_request_review':{'subject':'<subject-from-prepare>','expectedSequence':2,'comment':'Review the exact revision and unresolved findings.'},
 'governance_reopen_draft':{'subject':'<subject-from-prepare>','expectedSequence':4,'comment':'Address the requested changes.'},
 'governance_get':{'subject':'<subject-from-prepare>'},
 'governance_list':{'project':'neonatal-care'},
 'model_terminology_inspect':{'project':'neonatal-care','path':'templates/admission.oet'},
 'terminology_binding_plan':{'project':'neonatal-care','path':'templates/admission.oet'},
 'terminology_binding_plan_get':{'project':'neonatal-care','path':'templates/admission.oet'},
 'terminology_binding_plan_save':{'project':'neonatal-care','path':'templates/admission.oet','modelRevision':'<observed-model-revision>','aliases':[]},
 'terminology_catalogue_save':{'project':'neonatal-care','record':catalogue_record},
 'terminology_catalogue_get':{'project':'neonatal-care','kind':'code_system','canonical':catalogue_record['canonical'],'version':'1'},
 'terminology_catalogue_search':{'project':'neonatal-care','query':'feeding'},
 'terminology_catalogue_lookup':{'project':'neonatal-care','system':catalogue_record['canonical'],'code':'mixed'},
 'terminology_catalogue_validate':{'project':'neonatal-care','system':catalogue_record['canonical'],'code':'mixed','version':'1'},
 'terminology_catalogue_expand':{'project':'neonatal-care','valueSet':'https://example.org/sets/feeding','version':'1'},
 'terminology_catalogue_translate':{'project':'neonatal-care','conceptMap':'https://example.org/maps/feeding','system':catalogue_record['canonical'],'code':'mixed'},
})
local={'id':'feeding','system':'https://example.org/local/feeding','version':'1','source':'local','concepts':[{'code':'mixed','display':'Mixed feeding'}]}
examples['terminology_diff']={'before':local,'after':dict(local,version='2')}
examples['terminology_binding_validate']={'binding':{'id':'b','artifact':'templates/admission.oet','node':'/example','strength':'REQUIRED','value_set':'feeding','value_set_version':'1','codes':['mixed']},'valueSet':local,'model':'<template><Rule path="/example"/></template>'}
lines=['# MCP tool catalogue','','Generated from `tools/list` using `scripts/mcp-smoke.py --catalogue docs/evidence/tool-catalogue.json` and `python3 scripts/document-tools.py`. The snapshot contains complete input/output schemas; this page includes examples and operation boundaries. Prompts and resources are separately discoverable.','','## Contracts','','Every input is a closed JSON object: unknown top-level fields are rejected with JSON-RPC invalid parameters. Required fields, enum values and bounds below are executable schemas. Values marked as examples or placeholders must be replaced with retrieved identifiers/paths. Secrets belong in transport/server configuration, never tool arguments.','','Legacy retrieval tools retain their original text/resource or structured search results. New model/project/terminology tools return `success`, `result`, and `error`. `success:true` means the operation returned a report; inspect its `status`, `valid`, `warnings` and executed checks before claiming validation. Failures use `{ "success": false, "result": null, "error": { "code": "REVISION_CONFLICT", "message": "The artefact changed. Read the current revision before retrying.", "retryable": false } }`. Upstream dependency errors do not expose credentials or raw error bodies.','','`model_artifact_save` always creates a DRAFT revision. Project creation, artifact saving, branch creation and hosted review requests write persistent state and require deployment write enablement and, in OIDC mode, an authorized draft-write scope or role. No tool approves/releases a model. Read-only tools may contact configured external servers. See [capabilities](../CAPABILITIES.md) for partial or unavailable checks.']
for tool in sorted(tools,key=lambda t:t['name']):
 name=tool['name']; external=tool.get('annotations',{}).get('openWorldHint',True)
 lines+=['',f'## `{name}`','',tool.get('description','').strip(),'','External dependency: '+('configured CKM REST API.' if name.startswith('ckm_') and name!='ckm_sources' or name=='template_build_oet' else 'configured FHIR terminology provider when an external source is selected.' if external and name.startswith('terminology_') else 'configured Git remote or hosting API for hosted repository operations.' if name in {'model_repository_info','model_repository_branches','model_repository_diff','model_branch_create','model_review_request','model_review_get'} else 'configured native openEHR engine; no terminology server or CDR required.' if name in {'archetype_validate','template_validate','template_compile','template_compile_project','opt_validate','model_inspect','aql_validate'} else 'none.'),'','Input schema:','','```json',json.dumps(tool['inputSchema'],indent=2),'```','','Example `tools/call` parameters:','','```json',json.dumps({'name':name,'arguments':examples[name]},indent=2),'```']
 if 'outputSchema' in tool:lines+=['','Output schema:','','```json',json.dumps(tool['outputSchema'],indent=2),'```']
 else:lines+=['','Output: MCP content blocks (text or embedded resources), except `ckm_sources`, which returns the default source name and configured source URL map.']
 if name.startswith('model_') or name=='template_build_oet':lines+=['','Interpretation and errors: [repository](MODEL_REPOSITORY.md), [governance](GOVERNANCE.md), and [workflow](workflows/neonatal-admission.md). Partial validation never certifies deployability.']
 elif name.startswith('terminology_') and name!='terminology_resolve':lines+=['','Interpretation and errors: [terminology](TERMINOLOGY.md). Provider failures return NOT_EXECUTED; version confirmation and code membership are separate results.']
Path('docs/MCP_TOOLS.md').write_text('\n'.join(lines)+'\n')
