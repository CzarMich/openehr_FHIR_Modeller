#!/usr/bin/env python3
import importlib.util,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('gitops',ROOT/'scripts/fhir-prod-gitops.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class GitOpsTest(unittest.TestCase):
    def setUp(self):
        self.images={s:'registry.hygeoniq.com/openehr-fhir-modeller/'+s+'@sha256:'+'a'*64 for s in module.SERVICES}
        self.source='\n'.join('  image: registry.hygeoniq.com/application-parity/openehr-fhir-modeller-prod-'+s+'@sha256:'+'b'*64 for s in sorted(module.SERVICES))+'\n  imagePullSecrets:\n  - name: harbor-pull\n  volumes: retained\n'
    def test_only_exact_images_and_scoped_pull_identity_change(self):
        output=module.update(self.source,self.images)
        self.assertIn('volumes: retained',output)
        self.assertIn('- name: harbor-pull\n  - name: modeller-pull',output)
        self.assertEqual(module.update(output,self.images),output)
        for image in self.images.values():self.assertEqual(output.count(image),1)
    def test_missing_duplicate_mutable_or_unrelated_images_fail(self):
        for change in [dict(self.images,app='registry.hygeoniq.com/other/app:latest'),{k:v for k,v in self.images.items() if k!='app'}]:
            with self.assertRaises(ValueError):module.update(self.source,change)
        for source in [self.source.replace('prod-app@','unknown-app@'),self.source+self.source]:
            with self.assertRaises(ValueError):module.update(source,self.images)
    def test_workflow_preserves_dev_gate_and_targets_gitops_cluster(self):
        workflow=(ROOT/'.github/workflows/promote-production.yml').read_text()
        self.assertIn("run.conclusion !== 'success'",workflow)
        self.assertIn('promote-fhir-gitops.sh',workflow)
        self.assertIn('hyq@192.168.178.30',workflow)
        self.assertNotIn('amcdr@82.165.59.171',workflow)
        self.assertNotIn('deploy-fhir-prod.sh',workflow)
        script=(ROOT/'scripts/promote-fhir-gitops.sh').read_text()
        self.assertIn('--preserve-digests',script)
        self.assertIn('fhir-promotion-evidence.py',script)
        self.assertNotIn('docker build ',script)
    def test_runtime_manifest_identity_handles_containerd_and_pinned_indexes(self):
        spec=importlib.util.spec_from_file_location('verify',ROOT/'scripts/verify-fhir-kubernetes.py')
        verify=importlib.util.module_from_spec(spec);spec.loader.exec_module(verify)
        image='registry.hygeoniq.com/openehr-fhir-modeller/app@sha256:'+'a'*64
        status={'ready':True,'image':'sha256:'+'b'*64,'imageID':'registry.hygeoniq.com/openehr-fhir-modeller/app@sha256:'+'a'*64}
        self.assertTrue(verify.matches_image(status,image,[]))
        status['imageID']='registry.hygeoniq.com/openehr-fhir-modeller/app@sha256:'+'c'*64
        self.assertFalse(verify.matches_image(status,image,[]))
        self.assertTrue(verify.matches_image(status,image,['sha256:'+'c'*64]))
        status['ready']=False
        self.assertFalse(verify.matches_image(status,image,['sha256:'+'c'*64]))
if __name__=='__main__':unittest.main()
