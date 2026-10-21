import unittest,sys,csv,io
from pathlib import Path
sys.path.insert(0,str(Path(__file__).parent))
from scenario_csv import parse

def text(rows):
    out=io.StringIO();w=csv.writer(out);w.writerow(['seconds','action','target','value']);w.writerows(rows);return out.getvalue()
class OutputMappingTests(unittest.TestCase):
    def test_actions_normalize_without_generating(self):
        plan=parse(text([[0,'output_source','screen-7','a'],[1,'output_visible','screen-7','false'],[2,'output_fade','screen-7','crossfade'],[3,'output_fade_sec','screen-7','0.8'],[4,'output_black_sec','screen-7','0.12'],[5,'output_face_blur','screen-7','true'],[6,'output_blur_px','screen-7','12'],[7,'output_image','screen-8','stored-id'],[8,'end','','']]))
        self.assertFalse(any(c.get('generate') for c in plan['cues']))
        self.assertEqual(plan['cues'][3]['outputs'][0]['patch'],{'fadeDurationMs':800})
        self.assertEqual(plan['cues'][4]['outputs'][0]['patch'],{'blackHoldMs':120})
        self.assertEqual(plan['cues'][5]['outputs'][0]['patch'],{'faceBlur':{'enabled':True}})
        self.assertEqual(plan['cues'][7]['outputs'][0]['patch'],{'source':'fixed','contentId':'stored-id'})
    def test_invalid_values_rejected(self):
        for action,value in [('output_visible','yes'),('output_fade','weird'),('output_fade_sec','nan'),('output_fade_sec','10.1'),('output_black_sec','0.0005'),('output_blur_px','41'),('output_source','http://x'),('output_image',''),('output_unknown','a')]:
            with self.subTest(action=action,value=value),self.assertRaises(ValueError):parse(text([[0,action,'screen-7',value],[1,'end','','']]))
    def test_invalid_targets_and_unused_image_columns(self):
        with self.assertRaises(ValueError):parse(text([[0,'output_source','../x','a']]))
        with self.assertRaises(ValueError):parse('seconds,action,target,value,opacity\n0,output_source,screen-7,a,0.5\n')
    def test_old_layout_prompt_oneshot_generate_survive(self):
        p=parse(text([[0,'layout','','A|B|C|NOW'],[0,'prompt','A','sit'],[1,'one_shot','B','stand'],[2,'generate','',''],[3,'end','','']]))
        self.assertEqual(p['cues'][0]['layout'],['display_a','display_b','display_c','display_now'])
        self.assertEqual(p['cues'][1]['prompts'],{'gen_a':'sit'})
        self.assertEqual(p['cues'][2]['oneShot'],{'gen_b':'stand'})
        self.assertTrue(p['cues'][3]['generate'])
    def test_output_sequence(self):
        p=parse(text([[0,'output_sequence','screen-10','demo|5|2|4'],[1,'output_sequence','screen-9','demo|40||'],[2,'output_sequence','screen-9','demo'],[3,'end','','']]))
        self.assertEqual(p['cues'][0]['outputs'][0]['patch'],{'source':'fixed-sequence','sequenceFolder':'demo','frameSec':5,'startFrame':2,'endFrame':4,'loop':True})
        self.assertEqual(p['cues'][1]['outputs'][0]['patch'],{'source':'fixed-sequence','sequenceFolder':'demo','frameSec':40,'startFrame':1,'endFrame':None,'loop':True})
        self.assertEqual(p['cues'][2]['outputs'][0]['patch']['frameSec'],30)
        for target,value in [('screen-10','../x|5'),('screen-10','demo|0'),('screen-10','demo|5|3|2'),('screen-10','demo|5|0'),('screen-10','demo|5|1|2|9'),('screen-10',''),('current-a','demo'),('A','demo')]:
            with self.subTest(target=target,value=value),self.assertRaises(ValueError):parse(text([[0,'output_sequence',target,value],[1,'end','','']]))
    def test_labels_subtitles_delay_scene(self):
        p=parse(text([[0,'output_labels','screen-7','false'],[1,'output_subtitles','screen-7','true'],[2,'output_delay_sec','screen-7','5'],[3,'output_scene','screen-7','c']]))
        self.assertEqual(p['cues'][0]['outputs'][0]['patch'],{'labels':False})
        self.assertEqual(p['cues'][2]['outputs'][0]['patch'],{'delaySec':5})
    def test_channel_label_text_targets(self):
        channels=['current-now','current-a','current-b','current-c','control-output-1','control-output-2','control-output-3','control-output-4']
        p=parse(text([[i,'output_labels' if i%2==0 else 'output_subtitles',name,'false'] for i,name in enumerate(channels)]+[[9,'end','','']]))
        self.assertEqual(p['cues'][0]['outputs'],[{'id':'current-now','patch':{'labels':False}}])
        self.assertEqual(p['cues'][7]['outputs'],[{'id':'control-output-4','patch':{'subtitles':False}}])
    def test_channel_targets_reject_other_actions_and_bad_values(self):
        for action,target,value in [('output_source','current-a','b'),('output_visible','control-output-1','false'),('output_fade','current-now','none'),('output_face_blur','current-b','true'),('output_labels','current-d','false'),('output_labels','control-output-5','true'),('output_subtitles','current-a','yes')]:
            with self.subTest(action=action,target=target),self.assertRaises(ValueError) as ctx:parse(text([[0,action,target,value],[1,'end','','']]))
        with self.assertRaises(ValueError) as ctx:parse(text([[0,'output_source','current-a','b']]))
        self.assertIn('accepts only output_labels / output_subtitles',str(ctx.exception))
        with self.assertRaises(ValueError) as ctx:parse(text([[0,'output_labels','current-d','false']]))
        self.assertIn('current-now',str(ctx.exception))
    def test_engine_rejects_channel_patch_with_other_fields(self):
        from scenario_engine import output_patches
        for rows in ([{'id':'current-a','patch':{'source':'b'}}],[{'id':'control-output-2','patch':{'labels':'false'}}],[{'id':'current-a','patch':{}}],[{'id':'current-a','patch':{'labels':True}},{'id':'current-a','patch':{'subtitles':True}}]):
            with self.subTest(rows=rows),self.assertRaises(ValueError):output_patches(rows)
        self.assertEqual(output_patches([{'id':'current-c','patch':{'labels':True,'subtitles':False}}])[0]['id'],'current-c')
if __name__=='__main__':unittest.main()
