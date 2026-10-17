# -*- coding: utf-8 -*-
"""Run: python -I tests/test_display_sync.py   (no TouchDesigner, no paid calls; local fake HTTP server only)"""
import json
import os
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'touchdesigner'))
import td_display_sync as ds  # noqa: E402

LATEST = {
    'captureId': 'td-2', 'observation': 'An office.', 'savedAt': '2026-10-15T05:48:55.466Z',
    'scenarios': [
        {'sceneKey': 'gen_a', 'label': 'Gen_a', 'text': 'A text'},
        {'sceneKey': 'gen_b', 'label': '', 'text': 'B text'},
        {'label': 'Gen_c', 'text': 'C text'},
    ],
}
HISTORY = {'count': 2, 'items': [
    {'captureId': 'td-1', 'at': '2026-10-15T14:42:24', 'observation': 'first', 'hasPerson': False},
    {'captureId': 'td-2', 'at': '2026-10-15T14:47:06', 'observation': 'second', 'hasPerson': True},
], 'text': '1. first\n2. second'}


class Formatting(unittest.TestCase):
    def test_latest_prediction_to_scenario_latest_text(self):
        n = ds.normalize_latest_prediction(LATEST, ('gen_a', 'gen_b', 'gen_c'))
        self.assertEqual(n['captureId'], 'td-2')
        self.assertEqual(n['rows'][2][0], 'gen_c')                 # missing sceneKey -> by index
        text = ds.format_scenario_latest(n['captureId'], n['observation'], n['rows'])
        self.assertEqual(text.splitlines()[0], '[captureId: td-2]')
        self.assertIn(u'■ 現在\nAn office.', text)
        self.assertIn(u'● Gen_a (gen_a)\nA text', text)
        self.assertIn(u'● gen_b (gen_b)\nB text', text)       # empty label -> sceneKey
        self.assertTrue(text.endswith('\n'))

    def test_scenario_table_has_header(self):
        n = ds.normalize_latest_prediction(LATEST)
        rows = ds.scenario_table_rows(n['rows'])
        self.assertEqual(rows[0], ['sceneKey', 'label', 'text'])
        self.assertEqual(len(rows), 4)

    def test_bad_input(self):
        self.assertIsNone(ds.normalize_latest_prediction(None))
        self.assertEqual(ds.normalize_latest_prediction({'scenarios': 'x'})['rows'], [])

    def test_history_newest_first_and_jst(self):
        rows = ds.history_table_rows(HISTORY)
        self.assertEqual(rows[0], ['time(JST)', 'captureId', 'observation', 'hasPerson'])
        self.assertEqual(rows[1], ['2026-10-15 14:47:06', 'td-2', 'second', 1])
        self.assertEqual(rows[2][1], 'td-1')
        self.assertEqual(ds.history_table_rows(None), [ds.HISTORY_HEADER])

    def test_format_jst(self):
        self.assertEqual(ds.format_jst('2026-10-15T14:47:06'), '2026-10-15 14:47:06')
        self.assertEqual(ds.format_jst('2026-10-15T05:48:55.466Z'), '2026-10-15 14:48:55')
        self.assertEqual(ds.format_jst('garbage'), 'garbage')
        self.assertEqual(ds.format_jst(None), '')

    def test_action_log_text(self):
        self.assertEqual(ds.action_log_text(HISTORY), '1. first\n2. second')
        self.assertEqual(ds.action_log_text({}), '')


class FadeDecisions(unittest.TestCase):
    def test_same_capture_id_only_once(self):
        self.assertTrue(ds.should_trigger_fade(None, 'a'))
        self.assertFalse(ds.should_trigger_fade('a', 'a'))
        self.assertTrue(ds.should_trigger_fade('a', 'b'))
        self.assertTrue(ds.should_trigger_fade('a', ''))           # unknown id always plays

    def test_retrigger_plan(self):
        self.assertEqual(ds.fade_action(True), 'refade')
        self.assertEqual(ds.fade_action(False), 'raise')

    def test_hold(self):
        self.assertAlmostEqual(ds.fade_out_hold_ms(1.0, 0.8), 920.0)
        self.assertAlmostEqual(ds.fade_out_hold_ms(0.5, 0.8), 520.0)
        self.assertEqual(ds.fade_out_hold_ms(1.0, 0.8, 300), 300.0)
        self.assertEqual(ds.fade_out_hold_ms(None, 0.8), 1600.0)


class Handler(BaseHTTPRequestHandler):
    prediction_status = 200
    prediction_id = 'td-2'
    calls = {'pred': 0, 'reset': 0}

    def log_message(self, *a):
        pass

    def _send(self, code, body):
        data = json.dumps(body).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.startswith('/api/latest-prediction'):
            Handler.calls['pred'] += 1
            if Handler.prediction_status != 200:
                return self._send(Handler.prediction_status, {'error': 'none'})
            body = dict(LATEST)
            body['captureId'] = Handler.prediction_id
            return self._send(200, body)
        if self.path.startswith('/api/action-history'):
            return self._send(200, HISTORY)
        self._send(404, {})

    def do_POST(self):
        if self.path == '/api/reset-history':
            Handler.calls['reset'] += 1
            return self._send(200, {'ok': True, 'archivedTo': 'logs/archive/x'})
        self._send(404, {})


class Fetch(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = HTTPServer(('127.0.0.1', 0), Handler)
        cls.base = 'http://127.0.0.1:{}'.format(cls.httpd.server_address[1])
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()

    def setUp(self):
        Handler.prediction_status = 200
        Handler.prediction_id = 'td-2'
        Handler.calls = {'pred': 0, 'reset': 0}

    def test_fetch_ok(self):
        r = ds.fetch_display_data(self.base, 'td-2', ('gen_a', 'gen_b', 'gen_c'), sleep=lambda s: None)
        self.assertEqual(r['prediction']['captureId'], 'td-2')
        self.assertEqual(r['history']['count'], 2)
        self.assertEqual(r['errors'], [])

    def test_stale_prediction_retries_then_none(self):
        Handler.prediction_id = 'td-old'
        r = ds.fetch_display_data(self.base, 'td-2', sleep=lambda s: None)
        self.assertIsNone(r['prediction'])
        self.assertEqual(Handler.calls['pred'], ds.PREDICTION_RETRIES)
        self.assertIsNotNone(r['history'])

    def test_404_prediction(self):
        Handler.prediction_status = 404
        r = ds.fetch_display_data(self.base, 'td-2', sleep=lambda s: None)
        self.assertIsNone(r['prediction'])
        self.assertTrue(r['errors'])

    def test_server_down(self):
        r = ds.fetch_display_data('http://127.0.0.1:9', 'td-2', sleep=lambda s: None)
        self.assertIsNone(r['prediction'])
        self.assertIsNone(r['history'])

    def test_reset(self):
        out = ds.post_reset_history(self.base)
        self.assertTrue(out['ok'])
        self.assertEqual(out['archived'], 'logs/archive/x')
        self.assertFalse(ds.post_reset_history('http://127.0.0.1:9')['ok'])


if __name__ == '__main__':
    unittest.main()
