import unittest,sys,csv,io
from pathlib import Path
sys.path.insert(0,str(Path(__file__).parent))
from scenario_csv import parse
from scenario_engine import validate

def text(rows):
    out=io.StringIO();w=csv.writer(out);w.writerow(['seconds','action','target','value']);w.writerows(rows);return out.getvalue()
class SceneModeTests(unittest.TestCase):
    def test_all_modes_accepted(self):
        p=parse(text([[0,'scene_mode','A','asset_only'],[1,'scene_mode','B','people_and_assets'],[2,'scene_mode','C','default'],[3,'end','','']]))
        self.assertEqual([c['sceneModes'] for c in p['cues'][:3]],[{'gen_a':'asset_only'},{'gen_b':'people_and_assets'},{'gen_c':'default'}])
    def test_invalid_rejected(self):
        for target,value in [('A','people'),('A',''),('D','people_and_assets'),('','people_and_assets')]:
            with self.subTest(target=target,value=value),self.assertRaises(ValueError):parse(text([[0,'scene_mode',target,value],[1,'end','','']]))
    def test_unknown_value_rejected(self):
        with self.assertRaises(ValueError):parse(text([[0,'scene_mode','A','bogus'],[1,'end','','']]))
if __name__=='__main__':unittest.main()
