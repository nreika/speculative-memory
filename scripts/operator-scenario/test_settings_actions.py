import unittest,sys,csv,io
from pathlib import Path
sys.path.insert(0,str(Path(__file__).parent))
from scenario_csv import parse,load
from scenario_engine import validate

U1='11111111-1111-4111-8111-111111111111';U2='22222222-2222-4222-8222-222222222222'
def text(rows):
    out=io.StringIO();w=csv.writer(out);w.writerow(['seconds','action','target','value']);w.writerows(rows);return out.getvalue()
class SettingsActionTests(unittest.TestCase):
    def test_actions_normalize_to_settings_patches(self):
        p=parse(text([[0,'mode','','timer'],[1,'interval_sec','','30'],[2,'distance','B','-120.5'],[3,'presence','','0.5'],[4,'tone','','0'],[5,'person_refs','A',U1.upper()+'|'+U2],[6,'person_refs_once','C',''],[7,'pause','',''],[8,'resume','',''],[9,'end','','']]))
        c=p['cues']
        self.assertEqual(c[0]['settings'],{'mode':'timer'})
        self.assertEqual(c[1]['settings'],{'intervalSec':30})
        self.assertEqual(c[2]['settings'],{'scenes':{'b':{'distanceSec':-120.5}}})
        self.assertEqual(c[3]['settings'],{'presence':0.5})
        self.assertEqual(c[4]['settings'],{'tone':0})
        self.assertEqual(c[5]['settings'],{'scenes':{'a':{'continuousPersonReferenceIds':[U1,U2]}}})
        self.assertEqual(c[6]['settings'],{'scenes':{'c':{'oneShotPersonReferenceIds':[]}}})
        self.assertEqual([c[7]['hold'],c[8]['hold']],['pause','resume'])
        self.assertFalse(any(x.get('generate') for x in c))
    def test_invalid_values_rejected(self):
        bad=[('mode','','auto'),('mode','A','timer'),('interval_sec','','4'),('interval_sec','','3601'),('interval_sec','','soon'),('distance','A','3600.5'),('distance','D','10'),('distance','','10'),('distance','A','nan'),('presence','','1.1'),('presence','','-0.1'),('tone','D','0.5'),('presence','B','1.5'),('tone','a ','x'),('tone','','inf'),('person_refs','A','not-a-uuid'),('person_refs','A',U1+'|'+U1.upper()),('person_refs','A','|'.join([U1]*16)),('person_refs_once','','' ),('person_refs','A','/private/photo.jpg'),('pause','A',''),('resume','','1')]
        for action,target,value in bad:
            with self.subTest(action=action,target=target,value=value),self.assertRaises(ValueError):parse(text([[0,action,target,value],[1,'end','','']]))
    def test_empty_person_action(self):
        p=parse(text([[0,'empty_person','','0.5'],[1,'empty_person','','0'],[2,'empty_person','','1'],[3,'end','','']]))
        self.assertEqual([c['settings'] for c in p['cues']],[{'emptyRoomPersonChance':0.5},{'emptyRoomPersonChance':0},{'emptyRoomPersonChance':1}])
        for target,value in [('','1.1'),('','-0.1'),('','nan'),('','inf'),('','often'),('A','0.5'),('','')]:
            with self.subTest(target=target,value=value),self.assertRaises(ValueError):parse(text([[0,'empty_person',target,value],[1,'end','','']]))
        self.assertEqual(validate({'version':1,'id':'x','cues':[{'id':'c','atSec':0,'settings':{'emptyRoomPersonChance':0.25}}]})['cues'][0]['settings'],{'emptyRoomPersonChance':0.25})
        with self.assertRaises(ValueError):validate({'version':1,'id':'x','cues':[{'id':'c','atSec':0,'settings':{'emptyRoomPersonChance':2}}]})
    def test_image_columns_must_stay_empty(self):
        with self.assertRaises(ValueError):parse('seconds,action,target,value,opacity\n0,presence,,0.5,0.5\n')
    def test_engine_rejects_malformed_documents(self):
        for cue in [{'settings':{'mode':'timer','tone':0.1}},{'settings':{'scenarioPreview':True}},{'settings':{'scenes':{'a':{'continuous':'x'}}}},{'hold':'stop'},{'settings':{'tone':0.1},'hold':'pause'}]:
            with self.subTest(cue=cue),self.assertRaises(ValueError):validate({'version':1,'id':'x','cues':[{'id':'c','atSec':0,**cue}]})
    def test_per_scene_presence_tone(self):
        p=parse(text([[0,'presence','B','0.8'],[1,'tone','C','0.25'],[2,'presence','','0.4'],[3,'end','','']]))
        c=p['cues']
        self.assertEqual(c[0]['settings'],{'scenes':{'b':{'presence':0.8}}})
        self.assertEqual(c[1]['settings'],{'scenes':{'c':{'tone':0.25}}})
        self.assertEqual(c[2]['settings'],{'presence':0.4})
        for cue in c:validate({'version':1,'id':'x','cues':[{**cue,'id':'c'}]})
        with self.assertRaises(ValueError):validate({'version':1,'id':'x','cues':[{'id':'c','atSec':0,'settings':{'scenes':{'a':{'tone':2}}}}]})
    def test_example_loads(self):
        plan,_=load(Path(__file__).parent/'examples'/'SCN-SETTINGS-001.csv')
        self.assertEqual(plan['id'],'SCN-SETTINGS-001');self.assertEqual(plan['durationSec'],20)
        self.assertEqual([c['atSec'] for c in plan['cues']],[0,4,6,8,10,12,16])
        self.assertEqual(plan['cues'][2]['settings'],{'scenes':{'b':{'presence':0.8}}})
        self.assertEqual(plan['cues'][4]['settings'],{'emptyRoomPersonChance':0.5})
        self.assertEqual(plan['cues'][0]['settings'],{'scenes':{'a':{'distanceSec':10}}})
        self.assertFalse(any(c.get('generate') for c in plan['cues']))
if __name__=='__main__':unittest.main()
