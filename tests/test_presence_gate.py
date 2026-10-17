# -*- coding: utf-8 -*-
"""Run: python -I tests/test_presence_gate.py   (no TouchDesigner needed)"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'touchdesigner'))
from td_presence_gate import next_state, capture_allowed, describe  # noqa: E402


class PresenceGate(unittest.TestCase):
    def test_disabled_is_off_and_never_fires(self):
        for state in ('off', 'waiting', 'active', 'paused'):
            for person in (True, False, None):
                self.assertEqual(next_state(state, person, 100, 50, 300, enabled=False), ('off', False))
        self.assertTrue(capture_allowed('off'))

    def test_first_enable_goes_waiting_and_holds_captures(self):
        self.assertEqual(next_state('off', None, 100, 0, 300), ('waiting', False))
        self.assertEqual(next_state('off', False, 100, 0, 300), ('waiting', False))
        self.assertFalse(capture_allowed('waiting'))

    def test_person_starts_capture_once(self):
        self.assertEqual(next_state('waiting', True, 100, 0, 300), ('active', True))
        self.assertEqual(next_state('off', True, 100, 0, 300), ('active', True))
        self.assertEqual(next_state('active', True, 105, 100, 300), ('active', False))
        self.assertTrue(capture_allowed('active'))

    def test_idle_timeout_pauses(self):
        self.assertEqual(next_state('active', False, 399, 100, 300), ('active', False))
        self.assertEqual(next_state('active', False, 400, 100, 300), ('paused', False))
        self.assertFalse(capture_allowed('paused'))

    def test_idle_zero_never_stops(self):
        self.assertEqual(next_state('active', False, 10 ** 6, 100, 0), ('active', False))

    def test_person_resumes_from_paused_and_fires(self):
        self.assertEqual(next_state('paused', True, 500, 100, 300), ('active', True))

    def test_empty_keeps_waiting_and_paused(self):
        self.assertEqual(next_state('waiting', False, 500, 0, 300), ('waiting', False))
        self.assertEqual(next_state('paused', False, 500, 100, 300), ('paused', False))

    def test_unknown_changes_nothing(self):
        for state in ('waiting', 'active', 'paused'):
            self.assertEqual(next_state(state, None, 10 ** 6, 100, 300), (state, False))

    def test_describe(self):
        self.assertEqual(describe('off', 0, 10), 'off')
        self.assertEqual(describe('waiting', 0, 10), 'waiting (no person yet)')
        self.assertEqual(describe('active', 100, 130), 'active (last person 30s ago)')


if __name__ == '__main__':
    unittest.main()
