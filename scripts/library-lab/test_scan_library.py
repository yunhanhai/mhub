"""Focused scanner policy tests; no accounts, audio or local paths embedded in source."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('scan_library', Path(__file__).with_name('scan_library.py'))
scanner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scanner)


def record(name='song.flac', version='a' * 64):
    return {'path': name, 'title': 'Original title', 'artist': 'Artist', 'album': 'Album', 'duration': 12000,
            'format': 'flac', 'contentType': 'audio/flac', 'size': 1000, 'sha256': version,
            'modifiedAt': '2026-01-01T00:00:00+00:00', 'supported': True,
            'trackNumber': 1, 'year': 2026, 'artwork': None}


class PolicyTests(unittest.TestCase):
    def test_new_music_is_restricted_until_explicit_permission_review(self):
        policy, diff = scanner.candidate_policy([record()], {'instanceId': 'instance', 'files': [{'path': 'song.flac', 'songId': 'song'}]}, None)
        self.assertEqual(policy['tracks'][0]['access'], 'restricted')
        self.assertEqual(policy['tracks'][0]['allowedUserIds'], [])
        self.assertEqual(diff['automaticGrants'], 0)

    def test_existing_grants_are_preserved_during_same_size_file_version_change(self):
        existing = {**record(), 'songId': 'song', 'access': 'restricted', 'allowedUserIds': ['reader'], 'provenance': 'Owned original recording'}
        policy, diff = scanner.candidate_policy([record(version='b' * 64)], {'instanceId': 'instance', 'files': [{'path': 'song.flac', 'songId': 'song'}]}, {'instanceId': 'instance', 'tracks': [existing]})
        self.assertEqual(policy['tracks'][0]['allowedUserIds'], ['reader'])
        self.assertEqual(policy['tracks'][0]['access'], 'restricted')
        self.assertEqual(policy['tracks'][0]['provenance'], 'Owned original recording')
        self.assertIn('file_version_changed', diff['changes'][0]['reasons'])

    def test_unbound_policy_entries_are_preserved(self):
        old = {**record(), 'songId': 'old', 'access': 'public', 'allowedUserIds': []}
        policy, diff = scanner.candidate_policy([record()], {'instanceId': 'instance', 'files': []}, {'instanceId': 'instance', 'tracks': [old]})
        self.assertEqual(policy['tracks'], [old])
        self.assertEqual(diff['preservedUnboundSongIds'], ['old'])
        self.assertEqual(diff['automaticDeletions'], 0)

    def test_bindings_cannot_change_grants(self):
        for key, value in [('access', 'public'), ('allowedUserIds', ['new-user'])]:
            with self.assertRaises(ValueError):
                scanner.candidate_policy([record()], {'instanceId': 'instance', 'files': [{'path': 'song.flac', 'songId': 'song', key: value}]}, None)

    def test_absolute_escape_duplicate_and_missing_bindings_fail(self):
        for path in ['../song.flac', '/song.flac', 'C:\\song.flac']:
            with self.assertRaises(ValueError):
                scanner.relative_name(path)
        binding = {'instanceId': 'instance', 'files': [{'path': 'song.flac', 'songId': 'song'}]}
        with self.assertRaises(ValueError):
            scanner.candidate_policy([], binding, None)
        with self.assertRaises(ValueError):
            scanner.candidate_policy([record()], {**binding, 'files': binding['files'] * 2}, None)

    def test_different_instance_and_unsupported_bound_formats_fail(self):
        binding = {'instanceId': 'instance', 'files': [{'path': 'song.flac', 'songId': 'song'}]}
        with self.assertRaises(ValueError):
            scanner.candidate_policy([record()], binding, {'instanceId': 'other', 'tracks': []})
        with self.assertRaises(ValueError):
            scanner.candidate_policy([{**record(), 'supported': False}], binding, None)

    def test_metadata_normalization_removes_controls_and_bounds_length(self):
        self.assertEqual(scanner.text(' cafe\u0301\x00\n '), 'café')
        self.assertEqual(len(scanner.text('a' * 2000)), 512)

    def test_malformed_binding_shapes_fail_before_creating_a_policy(self):
        for binding in [None, [], {'files': {}}, {'instanceId': 'instance', 'files': [None]},
                        {'instanceId': 'instance', 'files': [{'path': 'song.flac', 'songId': []}]}]:
            with self.assertRaises(ValueError):
                scanner.candidate_policy([record()], binding, None)


if __name__ == '__main__':
    unittest.main()
