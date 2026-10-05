#!/usr/bin/env python3
"""Independent, standard-library MCP HTTP client. No LLM SDK or server internals.
Secrets are read from environment; evidence excludes headers, sessions and model content.
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path


class RpcError(Exception):
    def __init__(self, method, code):
        self.code = code
        super().__init__(f"{method}: JSON-RPC error {code}")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Client:
    def __init__(self, url, bearer=None):
        self.url, self.session, self.sequence = url, None, 0
        self.protocol_version = '2025-03-26'
        self.opener = urllib.request.build_opener(NoRedirect())
        self.headers = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json"}
        if bearer is not None:
            self.headers["Authorization"] = "Bearer " + bearer
        elif os.getenv("AUTH_API_KEY"):
            self.headers[os.getenv("AUTH_API_KEY_HEADER", "X-API-Key")] = os.environ["AUTH_API_KEY"]

    def rpc(self, method, params=None, notify=False):
        self.sequence += 1
        payload = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            payload["params"] = params
        if not notify:
            payload["id"] = self.sequence
        headers = dict(self.headers)
        if self.session:
            headers.update({"Mcp-Session-Id": self.session, "MCP-Protocol-Version": self.protocol_version})
        request = urllib.request.Request(self.url, data=json.dumps(payload).encode(), headers=headers)
        with self.opener.open(request, timeout=90) as response:
            self.session = response.headers.get("Mcp-Session-Id", self.session)
            raw = response.read(16 * 1024 * 1024 + 1)
            if len(raw) > 16 * 1024 * 1024:
                raise RuntimeError("MCP response exceeds the smoke client's size limit")
            body = raw.decode()
        if notify or not body:
            return {}
        if body.lstrip().startswith("{"):
            result = json.loads(body)
        else:
            events = [json.loads(line[5:].strip()) for line in body.splitlines() if line.startswith("data:") and line[5:].strip()]
            result = next(e for e in events if e.get("id") == self.sequence)
        assert result.get('jsonrpc') == '2.0' and result.get('id') == self.sequence, 'Mismatched JSON-RPC response'
        if "error" in result:
            raise RpcError(method, result["error"].get("code"))
        if method == 'initialize':
            self.protocol_version = result['result']['protocolVersion']
            assert self.protocol_version in ['2025-03-26', '2025-06-18', '2025-11-25']
        return result["result"]

    def listing(self, method, key):
        result, cursor = [], None
        while True:
            page = self.rpc(method, {"cursor": cursor} if cursor else {})
            result.extend(page.get(key, []))
            cursor = page.get("nextCursor")
            if not cursor:
                return result

    def tool(self, name, arguments=None, error=False):
        try:
            result = self.rpc("tools/call", {"name": name, "arguments": arguments or {}})
        except RpcError as exc:
            if error and exc.code == -32602:
                return {"rejected": True}
            raise
        if error:
            assert result.get("isError") or result.get("structuredContent", {}).get("success") is False
            return result
        assert not result.get("isError"), f"{name}: tool error"
        if "structuredContent" in result:
            data = result["structuredContent"]
        else:
            text = "\n".join(c["text"] if c.get("type") == "text" else c.get("resource", {}).get("text", "") for c in result.get("content", []))
            try:
                data = json.loads(text)
            except json.JSONDecodeError:
                data = text
        if isinstance(data, dict) and "success" in data:
            assert data["success"], f"{name}: {data.get('error', {}).get('code')}"
            data = data["result"]
        return data


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:8343/mcp")
    parser.add_argument("--evidence", type=Path)
    parser.add_argument("--catalogue", type=Path, help="Write discovered public tool schemas")
    parser.add_argument("--live-ckm", action="store_true")
    parser.add_argument("--live-terminology", action="store_true")
    parser.add_argument("--without-terminology", action="store_true", help="Assert optional external terminology is unconfigured")
    parser.add_argument("--governance", action="store_true", help="Exercise enabled governance persistence with --writes")
    parser.add_argument("--writes", action="store_true", help="Create an isolated smoke project; requires enabled writes")
    args = parser.parse_args()
    client, checks = Client(args.url), []

    def record(name, detail=None):
        checks.append({"check": name, "status": "PASS", "detail": detail})
        print("PASS " + name, flush=True)

    try:
        init = client.rpc("initialize", {"protocolVersion": "2025-11-25", "capabilities": {},
                                          "clientInfo": {"name": "independent-smoke-client", "version": "1.0"}})
        assert init["serverInfo"]["name"] == os.getenv("MCP_SERVER_NAME", "openehr-modelling-assistant")
        client.rpc("notifications/initialized", notify=True)
        record("initialize", init["serverInfo"])
        tools = client.listing("tools/list", "tools")
        expected = {'ckm_federated_search', 'model_project_qa', 'model_traceability_save', 'model_traceability_get', 'model_traceability_explain', 'model_traceability_requirement', 'governance_prepare', 'governance_validate', 'governance_request_review', 'governance_reopen_draft', 'governance_get', 'governance_list', 'model_terminology_inspect', 'terminology_binding_plan', 'terminology_binding_plan_save', 'terminology_binding_plan_get', 'terminology_catalogue_save', 'terminology_catalogue_get', 'terminology_catalogue_search', 'terminology_catalogue_lookup', 'terminology_catalogue_validate', 'terminology_catalogue_expand', 'terminology_catalogue_translate', 'model_repository_info', 'model_repository_branches', 'model_repository_diff', 'model_branch_create', 'model_review_request', 'model_review_get', 'ckm_sources', 'ckm_archetype_search', 'ckm_archetype_get', 'ckm_template_search', 'ckm_template_get', 'guide_search', 'guide_get', 'guide_adl_idiom_lookup', 'examples_search', 'examples_get', 'type_specification_search', 'type_specification_get', 'terminology_resolve', 'model_projects', 'model_project_get', 'model_project_create', 'model_artifact_get', 'model_artifact_save', 'model_artifact_history', 'model_requirements_coverage', 'model_validate', 'model_diff', 'template_build_oet', 'model_qa', 'terminology_capabilities', 'terminology_lookup', 'terminology_validate_code', 'terminology_expand', 'terminology_translate', 'terminology_resource_search', 'terminology_resource_get', 'terminology_binding_validate', 'terminology_diff', 'terminology_manifest'}
        assert expected <= {t['name'] for t in tools}, 'Required tool missing from discovery'
        assert len({t['name'] for t in tools}) == len(tools)
        assert all(t['inputSchema'].get('additionalProperties') is False for t in tools)
        record("tools/list", [t['name'] for t in tools])
        if args.catalogue:
            args.catalogue.parent.mkdir(parents=True, exist_ok=True)
            args.catalogue.write_text(json.dumps(tools, indent=2) + "\n")
        prompts = client.listing("prompts/list", "prompts")
        assert len(prompts) == 14
        record("prompts/list", len(prompts))
        resources = client.listing("resources/list", "resources")
        assert resources
        record("resources/list", len(resources))
        templates = client.listing("resources/templates/list", "resourceTemplates")
        assert templates
        record("resources/templates/list", len(templates))
        item = next(r for r in resources if r['uri'].startswith('openehr://guides/'))
        assert client.rpc("resources/read", {"uri": item['uri']})['contents']
        record("resources/read")
        prompt = prompts[0]
        arguments = {a['name']: 'Explain a draft openEHR model' for a in prompt.get('arguments', []) if a.get('required')}
        assert client.rpc("prompts/get", {"name": prompt['name'], "arguments": arguments})['messages']
        record("prompts/get")
        sources = client.tool("ckm_sources")
        assert sources['default'] in sources['sources']
        record("configured CKMs", list(sources['sources']))
        for name, arguments in [("guide_search", {}), ("guide_get", {"category":"howto", "name":"spec-lookup"}),
                                ("examples_search", {}), ("type_specification_search", {"namePattern":"DV_TEXT"}),
                                ("terminology_resolve", {"input":"433"})]:
            assert client.tool(name, arguments), name + ': empty response'
            record(name)
        client.tool("model_validate", {"content": "<a/>", "format": "xml", "unexpected": True}, error=True)
        record("invalid input rejected")
        valid = client.tool("model_validate", {"content":"<a/>", "format":"xml"})
        assert valid['valid'] is True
        bad = client.tool("model_validate", {"content":"<!DOCTYPE a [<!ENTITY x SYSTEM 'file:///etc/passwd'>]><a>&x;</a>","format":"xml"})
        assert bad['valid'] is False
        record("XML validation and entity rejection")
        for data_format, document in [('flat', '{"observations/temperature|magnitude":37.5}'), ('structured', '{"ctx":{"setting":[{"|code":"238"}]},"observations":{"temperature":[{"|magnitude":37.5}]}}')]:
            checked = client.tool('model_validate', dict(content=document,format=data_format))
            assert checked['parse_valid'] is True and checked['structurally_valid'] is True
            assert checked['valid'] is None and checked['release_eligible'] is False
            assert {s['name']:s['status'] for s in checked['stages']}['openehr_conformance'] == 'NOT_EXECUTED'
        ambiguous = client.tool('model_validate',dict(content='{"x":1,"x":2}',format='flat'))
        assert ambiguous['valid'] is False and ambiguous['parse_valid'] is False
        record('separate parse, shape and conformance stages; ambiguous JSON rejected')
        qa = client.tool("model_qa", {"content":"SELECT e/ehr_id/value FROM EHR e", "format":"aql"})
        assert qa['release_eligible'] is False
        record("unavailable checks cannot certify release")
        repository = client.tool("model_repository_info")
        assert repository['capabilities']['storage']
        assert client.tool("model_projects")['capabilities']['storage']
        record("repository capability discovery")
        if args.writes:
            project = 'smoke-' + str(time.time_ns())
            created = client.tool('model_project_create', {'id': project, 'name':'Integration smoke'})
            first = client.tool('model_artifact_save', {'project':project,'path':'requirements/smoke.md','content':'Explicit test requirement','metadata':{'source':'synthetic integration check'}})
            got = client.tool('model_artifact_get', {'project':project,'path':'requirements/smoke.md'})
            assert got['content'] == 'Explicit test requirement'
            assert got['metadata']['source'] == 'synthetic integration check'
            second = client.tool('model_artifact_save', {'project':project,'path':'requirements/smoke.md','content':'Revised explicit test requirement','expectedRevision':first['revision']})
            assert first['revision'] != second['revision']
            client.tool('model_artifact_save', {'project':project,'path':'requirements/smoke.md','content':'stale','expectedRevision':first['revision']},error=True)
            assert len(client.tool('model_artifact_history', {'project':project,'path':'requirements/smoke.md'})['versions']) == 2
            record('persistent project, revisions, stale-write rejection', project)
            if repository['capabilities'].get('branching'):
                branch = client.tool('model_branch_create', {'branch': 'acceptance/' + project, 'baseRevision': second['revision']})
                assert branch['active_branch_changed'] is False
                diff = client.tool('model_repository_diff', {'baseRevision': first['revision'], 'headRevision': second['revision']})
                assert 'Revised explicit test requirement' in diff['patch']
                record('Git branch creation and revision diff')
            if repository.get('hosting') is None:
                client.tool('model_review_request', {'branch':'acceptance/test','title':'Synthetic review'}, error=True)
                record('unconfigured hosted review rejected')
            system, value_set, concept_map = 'https://example.org/local/fixture', 'https://example.org/sets/fixture', 'https://example.org/maps/fixture'
            common = {'name':'Synthetic terminology', 'provenance':{'source':'Independent MCP fixture'}}
            cs = dict(common, kind='code_system', canonical=system, version='cs-1', concepts=[{'code':'x','display':'Synthetic X'}])
            saved = client.tool('terminology_catalogue_save', {'project':project, 'record':cs})
            vs = dict(common, kind='value_set', canonical=value_set, version='vs-2', concepts=[{'system':system,'version':'cs-1','code':'x','display':'Synthetic X'}])
            client.tool('terminology_catalogue_save', {'project':project, 'record':vs})
            mapping = dict(common, kind='concept_map', canonical=concept_map, version='map-3', mappings=[{'source':{'system':system,'version':'cs-1','code':'x'},'target':{'system':'urn:oid:1.2.3','code':'y'},'relationship':'equivalent'}])
            client.tool('terminology_catalogue_save', {'project':project, 'record':mapping})
            assert client.tool('terminology_catalogue_lookup', {'project':project,'system':system,'code':'x'})['valid'] is True
            assert client.tool('terminology_catalogue_validate', {'project':project,'system':system,'code':'x','valueSet':value_set,'version':'vs-2','codeSystemVersion':'cs-1'})['valid'] is True
            assert client.tool('terminology_catalogue_expand', {'project':project,'valueSet':value_set})['complete'] is True
            candidates = client.tool('terminology_catalogue_translate', {'project':project,'conceptMap':concept_map,'system':system,'code':'x'})
            assert candidates['mapping_found'] and candidates['requires_review'] and candidates['applied'] is False
            assert client.tool('terminology_catalogue_search', {'project':project})['total'] == 3
            cs['description'] = 'Updated fixture description'
            client.tool('terminology_catalogue_save', {'project':project,'record':cs,'expectedRevision':saved['revision']})
            client.tool('terminology_catalogue_save', {'project':project,'record':cs,'expectedRevision':saved['revision']},error=True)
            old = client.tool('terminology_catalogue_get', {'project':project,'kind':'code_system','canonical':system,'version':'cs-1','revision':saved['revision']})
            assert 'description' not in old['resource'] and old['clinical_approval'] is False
            record('offline terminology catalogue, versions, mapping review and revision conflicts')
            model_path = 'templates/terminology-fixture.oet'
            model_xml = '<template xmlns="openEHR/v1/Template" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><definition archetype_id="openEHR-EHR-OBSERVATION.fixture.v1"><Rule path="/data/items[at0001]"><constraint xsi:type="textConstraint" limitToList="true"><includedValues>' + system + '::x</includedValues></constraint></Rule></definition></template>'
            model = client.tool('model_artifact_save', {'project':project,'path':model_path,'content':model_xml})
            args_plan = {'project':project,'path':model_path}
            inspected = client.tool('model_terminology_inspect', args_plan)
            assert len(inspected['inspection']['slots']) == 1 and inspected['model_changed'] is False
            planned = client.tool('terminology_binding_plan', args_plan)
            assert planned['analysis']['decisions'][0]['candidates'][0]['code_system_versions_confirmed'] is False
            aliases = [{'terminology_id':system,'system':system,'version':'cs-1'}]
            saved_plan = client.tool('terminology_binding_plan_save', dict(args_plan,modelRevision=model['revision'],aliases=aliases))
            assert saved_plan['plan']['analysis']['decisions'][0]['code_validation'][0]['valid'] is True
            assert saved_plan['clinical_approval'] is False and saved_plan['model_changed'] is False
            client.tool('terminology_binding_plan_save',dict(args_plan,modelRevision=model['revision']),error=True)
            assert client.tool('terminology_binding_plan_get', args_plan)['freshness']['status'] == 'CURRENT'
            client.tool('model_artifact_save',dict(project=project,path=model_path,content=model_xml+'\n',expectedRevision=model['revision']))
            assert client.tool('terminology_binding_plan_get', args_plan)['freshness']['status'] == 'STALE_OR_MODIFIED'
            record('revision-bound binding plans, offline validation, unchanged source and stale evidence detection')
            source = client.tool('model_artifact_get', dict(project=project, path=model_path))
            provenance = dict(description='Synthetic software acceptance only.', provenance=['Protocol fixture; no clinical specification.'])
            source_ref = {key: source[key] for key in ['path', 'revision', 'sha256']}
            graph = {'schema': 1, 'nodes': [
                dict(id='R-023', type='requirement', title='Synthetic requirement', priority='must', status='ACTIVE', **provenance),
                dict(id='D-1', type='decision', title='Explicit modelling choice', status='RECORDED', rationale='Use the recorded source rule.', **provenance),
                dict(id='C-1', type='template_constraint', title='Source rule', artifact=dict(source_ref, anchor={'kind':'xml_location','value':'/1/1/1'}), **provenance),
            ], 'edges': [
                dict(**{'from':'R-023','to':'D-1'}, relation='motivates', rationale='Requirement motivates the choice.'),
                dict(**{'from':'D-1','to':'C-1'}, relation='justifies', rationale='Recorded rationale for the exact rule.'),
                dict(**{'from':'R-023','to':'C-1'}, relation='satisfied_by', coverage='full', rationale='Explicit draft coverage assertion.'),
            ]}
            trace = client.tool('model_traceability_save', dict(project=project, graph=graph))
            assert trace['coverage'][0]['element_references_current_and_resolved'] and trace['clinical_approval'] is False
            assert client.tool('model_traceability_requirement', dict(project=project, requirement='R-023'))['requirement_coverage']['elements'] == ['C-1']
            assert [node['id'] for node in client.tool('model_traceability_explain', dict(project=project, node='C-1'))['graph']['nodes']] == ['C-1','D-1','R-023']
            client.tool('model_traceability_save', dict(project=project, graph=graph), error=True)
            client.tool('model_artifact_save',dict(project=project,path=model_path,content=model_xml+'\n\n',expectedRevision=source['revision']))
            stale_trace = client.tool('model_traceability_get', dict(project=project))
            assert stale_trace['evidence']['C-1']['status'] == 'STALE'
            assert stale_trace['semantic_satisfaction'] == 'NOT_ASSESSED'
            record('persistent requirement/decision queries, exact anchors, write conflicts and stale source evidence')
            if args.governance:
                source = client.tool('model_artifact_get', dict(project=project, path=model_path))
                prepared = client.tool('governance_prepare', dict(project=project, path=model_path, modelRevision=source['revision'], comment='Independent synthetic protocol check.'))
                checked = client.tool('governance_validate', dict(subject=prepared['subject'], expectedSequence=prepared['sequence']))
                assert checked['state'] == 'DRAFT' and checked['validation']['release_eligible'] is False
                reviewed = client.tool('governance_request_review', dict(subject=checked['subject'], expectedSequence=checked['sequence'], comment='Review incomplete synthetic model.'))
                assert reviewed['state'] == 'REVIEW_REQUESTED' and reviewed['clinical_approval'] is False
                assert reviewed['events'][-1]['actor']['human'] is False and len(reviewed['events']) == 3
                client.tool('governance_request_review', dict(subject=checked['subject'], expectedSequence=checked['sequence'], comment='Stale review must fail.'), error=True)
                assert len(client.tool('governance_list', dict(project=project))['items']) == 1
                assert client.tool('governance_get', dict(subject=prepared['subject']))['source']['sha256'] == source['sha256']
                record('authoritative governance audit, incomplete validation, agent review request and stale-event rejection')
                graph['nodes'][2]['artifact'].update({key: source[key] for key in ['path','revision','sha256']})
                event = checked['events'][1]
                graph['nodes'].append(dict(id='V-1',type='validation_evidence',title='Executed pipeline evidence',event=dict(subject=checked['subject'],sequence=event['sequence'],hash=event['hash']),**provenance))
                graph['edges'].append(dict(**{'from':'C-1','to':'V-1'},relation='validated_by',rationale='Installed pipeline executed for this exact revision.'))
                linked = client.tool('model_traceability_save',dict(project=project,graph=graph,expectedRevision=trace['artifact']['revision']))
                assert linked['evidence']['V-1']['status'] == 'VERIFIED'
                assert linked['evidence']['V-1']['release_eligible_at_event'] is False
                graph['nodes'][-1]['event']['hash'] = '0'*64
                client.tool('model_traceability_save',dict(project=project,graph=graph,expectedRevision=linked['artifact']['revision']),error=True)
                record('traceability resolves authentic exact-source validation and rejects fabricated event hashes')
                project_qa = client.tool('model_project_qa',dict(project=project,path=model_path))
                assert project_qa['release_eligible'] is False and project_qa['model_changed'] is False
                assert project_qa['traceability']['validation_events']['V-1']['status'] == 'VERIFIED'
                assert 'VALIDATION_NOT_QUALIFIED' in [f['code'] for f in project_qa['findings']]
                assert client.tool('model_artifact_get',dict(project=project,path=model_path))['revision'] == source['revision']
                record('project QA resolves actual validation evidence without modifying or approving the source')


        if args.live_ckm:
            for name, arguments in [('ckm_archetype_search', {'keyword':'body weight','maxResults':2}),
                                    ('ckm_archetype_get', {'identifier':'openEHR-EHR-OBSERVATION.body_weight.v2','format':'adl'}),
                                    ('ckm_template_search', {'keyword':'encounter','maxResults':2}),
                                    ('ckm_template_get', {'identifier':'1013.26.1','format':'oet'})]:
                assert client.tool(name, arguments)
                record('live '+name)
            draft = client.tool('template_build_oet', {'name':'Integration draft','composition':'openEHR-EHR-COMPOSITION.encounter.v1','entries':['openEHR-EHR-OBSERVATION.body_weight.v2']})
            assert draft['status'] == 'DRAFT'
            record('live CKM draft OET generation')
        if args.without_terminology:
            for name, arguments in [('terminology_capabilities', {}),
                                    ('terminology_lookup', {'system':'http://snomed.info/sct','code':'404684003'}),
                                    ('terminology_validate_code', {'system':'http://snomed.info/sct','code':'404684003'}),
                                    ('terminology_translate', {'conceptMap':'https://example.org/map','system':'https://example.org/cs','code':'x'}),
                                    ('terminology_resource_search', {'resourceType':'ValueSet'}),
                                    ('terminology_resource_get', {'resourceType':'ValueSet','canonical':'https://example.org/vs'})]:
                result = client.tool(name, arguments)
                assert result['status'] == 'NOT_EXECUTED', name
            manifest = client.tool('terminology_manifest', {'artifact':'templates/unbound.oet','bindings':[]})
            assert manifest['terminology_dependencies'] == []
            record('modelling without terminology server or bindings')
        if args.live_terminology:
            capabilities = client.tool('terminology_capabilities')
            assert capabilities['status'] == 'VALIDATED'
            system = os.getenv('SMOKE_TERMINOLOGY_SYSTEM','http://snomed.info/sct')
            code = os.getenv('SMOKE_TERMINOLOGY_CODE','404684003')
            lookup = client.tool('terminology_lookup', {'system':system,'code':code})
            assert lookup['status'] == 'VALIDATED', lookup.get('errors')
            record('live terminology lookup', {'returned_version':lookup.get('returned_version')})
            valid = client.tool('terminology_validate_code', {'system':system,'code':code})
            assert valid['valid'] is True, valid.get('errors')
            record('live CodeSystem validation')
            vs = os.getenv('SMOKE_VALUESET','http://snomed.info/sct?fhir_vs=isa/404684003')
            expanded = client.tool('terminology_expand', {'valueSet':vs,'count':2})
            assert expanded['status'] == 'VALIDATED', expanded.get('errors')
            members = expanded['result']['expansion']['contains']
            assert members
            record('live bounded ValueSet expansion', {'count':len(members), 'total':expanded['result']['expansion'].get('total')})
            member = members[0]
            result = client.tool('terminology_validate_code', {'system':member['system'],'code':member['code'],'valueSet':vs})
            assert result['valid'] is True, result.get('errors')
            record('live ValueSet membership')
    except Exception as exc:
        checks.append({'check':'smoke stopped', 'status':'FAIL', 'detail':str(exc)})
        print('FAIL ' + str(exc), file=sys.stderr)
        return 1
    finally:
        if args.evidence:
            args.evidence.parent.mkdir(parents=True, exist_ok=True)
            args.evidence.write_text(json.dumps({'timestamp':time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),'checks':checks}, indent=2)+'\n')
    return 0

if __name__ == '__main__':
    sys.exit(main())
