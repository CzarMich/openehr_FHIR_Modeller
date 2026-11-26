#!/usr/bin/env python3
"""Update only modeller image/pull-secret references in the existing GitOps workload."""
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
if __name__=='__main__':
    manifest,images=sys.argv[1:]
    path=Path(manifest);path.write_text(update(path.read_text(),json.loads(Path(images).read_text())))
