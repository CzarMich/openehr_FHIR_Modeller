#!/usr/bin/env python3
import importlib.util,json,tempfile,unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('spec_check',Path(__file__).with_name('spec-check.py'));module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class TraceabilityTest(unittest.TestCase):
    def fixture(self,root):
        (root/'docs/decisions').mkdir(parents=True)
        (root/'code.cs').write_text('// Synthetic traceability fixture\n')
        (root/'test.py').write_text('# Synthetic verification\n')
        (root/'docs/requirements.md').write_text('# Requirements\n\n**REQ-F1** — synthetic behaviour.\n')
        records=[{'id':'REQ-F1','title':'Synthetic behaviour','canonical':'docs/requirements.md','status':'draft','implementation':'landed','packages':['code.cs'],'tests':['test.py']}]
        (root/'docs/traceability.yaml').write_text(json.dumps({'requirements':records}))
        (root/'docs/traceability.md').write_text('# Matrix\n\n<!-- generated-requirements -->\n\n'+module.matrix(records))
        return records
    def test_valid_and_deleted_implementation(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);self.fixture(root);self.assertEqual(module.check(root),[])
            (root/'code.cs').unlink();self.assertTrue(any('missing/invalid path' in error for error in module.check(root)))
    def test_duplicate_ids_gap_and_matrix_drift(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);records=self.fixture(root);records.append(dict(records[0]));(root/'docs/traceability.yaml').write_text(json.dumps({'requirements':records}));self.assertTrue(any('duplicate' in error for error in module.check(root)))
            records.pop();records[0]['id']='REQ-F3';(root/'docs/traceability.yaml').write_text(json.dumps({'requirements':records}));errors=module.check(root);self.assertTrue(any('numbering gap' in error for error in errors));self.assertTrue(any('identifier drift' in error for error in errors));self.assertTrue(any('matrix drift' in error for error in errors))
    def test_render_repairs_only_the_derived_matrix(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);self.fixture(root);(root/'docs/traceability.md').write_text('# Matrix\n\n<!-- generated-requirements -->\n\nstale\n');self.assertTrue(module.check(root));self.assertEqual(module.check(root,True),[]);self.assertEqual(module.check(root),[])
if __name__=='__main__':unittest.main()
