import unittest,sys,json,subprocess,tempfile,os
from pathlib import Path
HERE=Path(__file__).parent
sys.path.insert(0,str(HERE))
from scenario_csv import collect,parse,check,errors_of,warnings_of

PNG=b'\x89PNG\r\n\x1a\n'+b'\0'*16
BAD='\n'.join(['seconds,action,target,value',
    '0,scenario,,BAD-1',
    'x,prompt,A,hello',          # 3 seconds not a number
    '1,bogus,,',                 # 4 unknown action
    '2,interval_sec,,4',         # 5 out of range
    '3,person_refs,A,not-a-uuid',# 6 UUID
    '4,prompt,A,too,many',       # 7 column count
    '0,scenario,,AGAIN',         # 8 duplicate meta
    '5,scene_mode,D,asset_only', # 9 target
    '6,end,,',
    '7,end,,',                   # 11 duplicate end
    '8,image,A,missing.png'])+'\n'  # 12 file missing (with base)

class CollectorTests(unittest.TestCase):
    def test_reports_every_error_with_rows_and_columns(self):
        with tempfile.TemporaryDirectory() as d:
            plan,issues=collect(BAD,'x',d)
        self.assertIsNone(plan)
        errors=errors_of(issues);rows={e['row'] for e in errors}
        self.assertTrue({3,4,5,6,7,8,9,11,12}<=rows,errors)
        by=lambda r:[e for e in errors if e['row']==r]
        self.assertEqual(by(3)[0]['column'],'seconds')
        self.assertEqual(by(4)[0]['column'],'action');self.assertIn('Unknown action: bogus',by(4)[0]['message'])
        self.assertEqual(by(6)[0]['column'],'value')
        self.assertEqual(by(9)[0]['column'],'target')
        self.assertIn('Wrong number of columns',by(7)[0]['message'])
        self.assertIn('Image file not found',' '.join(e['message'] for e in by(12)))
        self.assertTrue(all(e['severity']=='error' for e in errors))
        # The legacy single-error API still raises with the first problem.
        with self.assertRaisesRegex(ValueError,'CSV row 3'):parse(BAD)

    def test_header_problems_are_listed_together(self):
        plan,issues=collect('seconds,action,tagret,value,value\n0,end,,,\n')
        msgs=[i['message'] for i in errors_of(issues)]
        self.assertIsNone(plan);self.assertEqual({i['row'] for i in issues},{1})
        self.assertTrue(any('Duplicate column: value' in m for m in msgs))
        self.assertTrue(any('Unknown column: "tagret"' in m for m in msgs))
        self.assertTrue(any('Missing required column: target' in m for m in msgs))

    def test_cue_after_end_and_unused_image_columns(self):
        plan,issues=collect('seconds,action,target,value,opacity\n0,presence,,0.5,0.5\n30,tone,,0.5,\n20,end,,,\n')
        rows={(i['row'],i.get('column')) for i in errors_of(issues)}
        self.assertIn((2,'opacity'),rows);self.assertIn((3,'seconds'),rows)

    def test_warnings_only_loads(self):
        text='seconds,action,target,value,fit\n0,note,,hello,\n5,presence,,0.5,\n2,note,,hello,\n'
        plan,issues=collect(text)
        self.assertIsNotNone(plan);self.assertEqual(errors_of(issues),[])
        msgs=[(i['row'],i['message']) for i in warnings_of(issues)]
        self.assertTrue(any(r==1 and 'fit' in m for r,m in msgs),msgs)
        self.assertTrue(any(r==4 and 'Duplicate note' in m for r,m in msgs),msgs)
        self.assertTrue(any(r==4 and 'earlier than row 3' in m for r,m in msgs),msgs)
        self.assertTrue(any(r==0 and 'No end row' in m for r,m in msgs),msgs)
        self.assertEqual([c['atSec'] for c in plan['cues']],[0,2,5])

    def test_clean_file_has_no_issues(self):
        with tempfile.TemporaryDirectory() as d:
            Path(d,'a.png').write_bytes(PNG)
            plan,issues=collect('seconds,action,target,value,opacity\n0,scenario,,CLEAN,\n0,image,A,a.png,0.5\n1,generate,,,\n10,end,,,\n','x',d)
        self.assertEqual(issues,[]);self.assertEqual(plan['id'],'CLEAN');self.assertEqual(plan['durationSec'],10)

    def test_image_path_must_stay_in_folder(self):
        with tempfile.TemporaryDirectory() as d:
            for value,needle in [('../x.png','leaves'),('C:/x.png','relative'),('a.jpg','.png')]:
                with self.subTest(value=value):
                    _,issues=collect('seconds,action,target,value\n0,image,A,%s\n1,end,,\n'%value,'x',d)
                    self.assertIn(needle,errors_of(issues)[0]['message'])

    def test_crcrlf_rows_are_numbered_like_a_spreadsheet(self):
        with tempfile.TemporaryDirectory() as d:
            f=Path(d,'S.csv');f.write_bytes(b'seconds,action,target,value\r\r\n0,prompt,A,x\r\r\n1,bogus,,\r\r\n')
            _,issues=check(f)
        self.assertEqual(errors_of(issues)[0]['row'],3)

class ParsePlanJsonTests(unittest.TestCase):
    def run_cli(self,text,name='S.csv'):
        with tempfile.TemporaryDirectory() as d:
            f=Path(d,name);f.write_text(text,encoding='utf-8')
            r=subprocess.run([sys.executable,str(HERE/'parse_plan.py'),str(f)],capture_output=True)
        return r.returncode,json.loads(r.stdout.decode('ascii'))

    def test_errors_shape(self):
        code,out=self.run_cli(BAD)
        self.assertEqual(code,2);self.assertIs(out['ok'],False);self.assertNotIn('plan',out)
        self.assertGreaterEqual(len(out['formatErrors']),9)
        self.assertTrue(all({'row','message','severity'}<=set(e) for e in out['formatErrors']))
        self.assertIsInstance(out['formatWarnings'],list)

    def test_ok_shape_with_warnings(self):
        code,out=self.run_cli('seconds,action,target,value\n0,presence,,0.5\n')
        self.assertEqual(code,0);self.assertIs(out['ok'],True);self.assertEqual(out['plan']['id'],'S')
        self.assertEqual([w['row'] for w in out['formatWarnings']],[0])

if __name__=='__main__':unittest.main()
