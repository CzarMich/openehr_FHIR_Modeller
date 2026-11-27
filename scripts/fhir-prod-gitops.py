#!/usr/bin/env python3
"""Update a verified image cohort and its matching application HTTP runtime contract."""
import json,re,sys
from pathlib import Path
SERVICES={'app','chat','ingress','fhir','engine'}
def update(source,images):
    if set(images)!=SERVICES: raise ValueError('Five verified images required')
    for service,image in images.items():
        if not re.fullmatch(r'registry\.hygeoniq\.com/openehr-fhir-modeller/'+service+r'@sha256:[0-9a-f]{64}',image):
            raise ValueError('Unexpected production image')
        pattern=r'(\s+image: )(?:registry\.hygeoniq\.com/application-parity/openehr-fhir-modeller-prod-'+service+r'|registry\.hygeoniq\.com/openehr-fhir-modeller/'+service+r')@sha256:[0-9a-f]{64}'
        source,count=re.subn(pattern,lambda match:match[1]+image,source)
        if count!=1: raise ValueError('Expected exactly one '+service+' container')
    # Keep the old pull identity available for rollback; add the scoped new one.
    source=re.sub(r'(?m)^(\s*)- name: harbor-pull\n(?!\1- name: modeller-pull\n)',r'\1- name: harbor-pull\n\1- name: modeller-pull\n',source)
    return source
def application_http(source):
    # The infrastructure validator already requires PyYAML on the delivery runner.
    import yaml
    documents=list(yaml.safe_load_all(source))
    deployments={doc['metadata']['name']:doc for doc in documents if isinstance(doc,dict) and doc.get('kind')=='Deployment'}
    if set(deployments)!={'app','chat','ingress','fhir'}:raise ValueError('Unexpected workload cohort')
    app=deployments['app'];containers=app['spec']['template']['spec']['containers']
    targets=[container for container in containers if container.get('name')=='app']
    if len(targets)!=1:raise ValueError('Exactly one primary application container required')
    primary=targets[0]
    primary.pop('command',None);primary.pop('args',None)
    environment=primary.setdefault('env',[])
    if len({entry['name'] for entry in environment})!=len(environment):raise ValueError('Duplicate runtime environment setting')
    for name,value in [('MODELLER_APPLICATION_ENABLED','true'),('ASPNETCORE_URLS','http://0.0.0.0:9000')]:
        entries=[entry for entry in environment if entry['name']==name]
        if entries:entries[0].clear();entries[0].update(name=name,value=value)
        else:environment.append({'name':name,'value':value})
    for probe,path in [('startupProbe','/health'),('readinessProbe','/ready'),('livenessProbe','/health')]:
        settings=primary.setdefault(probe,{})
        for action in ['exec','tcpSocket','grpc']:settings.pop(action,None)
        settings['httpGet']={'path':path,'port':9000,'scheme':'HTTP','httpHeaders':[{'name':'Host','value':'127.0.0.1'}]}
    # One writer per persistent chat/channel store. Do not overlap orchestrators.
    for deployment in deployments.values():deployment['spec']['strategy']={'type':'Recreate'}
    return yaml.safe_dump_all(documents,sort_keys=False)

if __name__=='__main__':
    manifest,images=sys.argv[1:]
    path=Path(manifest);path.write_text(application_http(update(path.read_text(),json.loads(Path(images).read_text()))))
