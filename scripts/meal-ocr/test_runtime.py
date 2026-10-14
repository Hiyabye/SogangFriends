import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), Path(__file__).with_name(name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


batch = load('run-batch')
runtime = load('runtime-check')


class BatchTests(unittest.TestCase):
    def prepare(self, root, cached=False, index=0):
        relative = 'week-%d' % index
        directory = root / relative
        directory.mkdir()
        image = b'fixture image bytes'
        (directory / 'source.jpg').write_bytes(image)
        source = {'start': '2026-10-12'}
        (directory / 'source.json').write_text(json.dumps(source))
        entry = {'source': source, 'imageHash': hashlib.sha256(image).hexdigest(), 'cached': cached,
                 'mime': 'image/jpeg', 'imageFile': relative + '/source.jpg',
                 'sourceFile': relative + '/source.json', 'resultDirectory': relative + '/ocr'}
        (root / 'manifest.json').write_text(json.dumps({'version': 'ocr-v1', 'entries': [entry]}))
        return entry

    def test_no_work_is_not_a_verified_runtime(self):
        with tempfile.TemporaryDirectory() as path:
            root = Path(path)
            (root / 'manifest.json').write_text(json.dumps({'version': 'ocr-v1', 'entries': []}))
            with patch.object(batch.subprocess, 'run') as invoke:
                self.assertEqual(batch.run(root, require_processed=True), 1)
                invoke.assert_not_called()
            self.assertFalse(json.loads((root / 'batch-summary.json').read_text())['runtimeVerified'])

    def test_cache_hits_skip_engines_but_do_not_verify_runtime(self):
        for verification in (False, True):
            with tempfile.TemporaryDirectory() as path:
                root = Path(path)
                self.prepare(root, cached=True)
                with patch.object(batch.subprocess, 'run') as invoke:
                    self.assertEqual(batch.run(root, verification), int(verification))
                    invoke.assert_not_called()

    def test_real_processing_required_and_rejected_output_fails(self):
        for returncode in (0, 1):
            with tempfile.TemporaryDirectory() as path:
                root = Path(path)
                self.prepare(root)
                with patch.object(batch.subprocess, 'run', return_value=SimpleNamespace(returncode=returncode)):
                    self.assertEqual(batch.run(root, require_processed=True), returncode)
                summary = json.loads((root / 'batch-summary.json').read_text())
                self.assertEqual(summary['runtimeVerified'], returncode == 0)

    def test_timeout_is_failed_processing_not_runtime_verification(self):
        with tempfile.TemporaryDirectory() as path:
            root = Path(path)
            self.prepare(root)
            timeout = batch.subprocess.TimeoutExpired('fixture-engine', 600)
            with patch.object(batch.subprocess, 'run', side_effect=timeout) as invoke:
                self.assertEqual(batch.run(root, require_processed=True), 1)
                self.assertEqual(invoke.call_args.kwargs['timeout'], 600)
            summary = json.loads((root / 'batch-summary.json').read_text())
            self.assertEqual(summary['outcomes'], [{'index': 0, 'status': 'timeout'}])
            self.assertEqual(summary['failed'], 1)
            self.assertEqual(summary['processed'], 0)
            self.assertFalse(summary['runtimeVerified'])

    def test_failed_first_week_does_not_hide_second_week(self):
        for first in (SimpleNamespace(returncode=1), batch.subprocess.TimeoutExpired('fixture-engine', 600)):
            with self.subTest(first=type(first).__name__), tempfile.TemporaryDirectory() as path:
                root = Path(path)
                entries = [self.prepare(root, index=index) for index in range(2)]
                (root / 'manifest.json').write_text(json.dumps({'version': 'ocr-v1', 'entries': entries}))
                with patch.object(batch.subprocess, 'run', side_effect=[first, SimpleNamespace(returncode=0)]) as invoke:
                    self.assertEqual(batch.run(root), 1)
                    self.assertEqual(invoke.call_count, 2)
                summary = json.loads((root / 'batch-summary.json').read_text())
                self.assertEqual([item['status'] for item in summary['outcomes']],
                                 ['timeout' if isinstance(first, Exception) else 'rejected', 'accepted'])
                self.assertEqual(summary['failed'], 1)
                self.assertEqual(summary['processed'], 1)
                self.assertFalse(summary['runtimeVerified'])

    def test_one_cached_and_one_processed_week_verifies_only_real_work(self):
        with tempfile.TemporaryDirectory() as path:
            root = Path(path)
            entries = [self.prepare(root, cached=True), self.prepare(root, index=1)]
            (root / 'manifest.json').write_text(json.dumps({'version': 'ocr-v1', 'entries': entries}))
            with patch.object(batch.subprocess, 'run', return_value=SimpleNamespace(returncode=0)) as invoke:
                self.assertEqual(batch.run(root, require_processed=True), 0)
                invoke.assert_called_once()
                self.assertIn(str(root / 'week-1/source.jpg'), invoke.call_args.args[0])
            summary = json.loads((root / 'batch-summary.json').read_text())
            self.assertEqual([item['status'] for item in summary['outcomes']], ['cached', 'accepted'])
            self.assertEqual(summary['processed'], 1)
            self.assertTrue(summary['runtimeVerified'])

    def test_manifest_cannot_select_arbitrary_files(self):
        with tempfile.TemporaryDirectory() as path:
            root = Path(path)
            entry = self.prepare(root)
            entry['imageFile'] = '../other.jpg'
            (root / 'manifest.json').write_text(json.dumps({'version': 'ocr-v1', 'entries': [entry]}))
            with self.assertRaisesRegex(ValueError, 'Untrusted paths'):
                batch.run(root)


class ModelDigestTests(unittest.TestCase):
    def test_changed_native_weights_fail_verification(self):
        paths = {'PP-OCRv5_server_det': '.paddlex/official_models/PP-OCRv5_server_det/inference.pdiparams',
                 'korean_PP-OCRv5_mobile_rec': '.paddlex/official_models/korean_PP-OCRv5_mobile_rec/inference.pdiparams',
                 'craft_mlt_25k': '.EasyOCR/model/craft_mlt_25k.pth', 'korean_g2': '.EasyOCR/model/korean_g2.pth'}
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            snapshot = {'model_weights': []}
            for name, relative in paths.items():
                path = home / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b'approved')
                snapshot['model_weights'].append({'model': name, 'bytes': 8,
                                                  'sha256': hashlib.sha256(b'approved').hexdigest()})
            # Model weights must be hashed from bounded file reads, not one whole-file allocation.
            with patch.object(Path, 'read_bytes', side_effect=AssertionError('Unexpected whole-file read')):
                self.assertEqual(len(runtime.check_weights(snapshot, home)), 4)
            for value, message in ((b'modified', 'Model weights changed'), (b'longer modified', 'Model size changed')):
                (home / paths['korean_g2']).write_bytes(value)
                with self.subTest(message=message), self.assertRaisesRegex(ValueError, message):
                    runtime.check_weights(snapshot, home)


if __name__ == '__main__':
    unittest.main()
