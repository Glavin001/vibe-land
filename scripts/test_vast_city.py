"""Safety/freshness contracts: python3 -m unittest discover -s scripts -p test_vast_city.py"""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('vast_city', Path(__file__).with_name('vast-city.py'))
v = importlib.util.module_from_spec(spec)
spec.loader.exec_module(v)


class DeploymentContracts(unittest.TestCase):
    def test_mapping_ignores_invalid_container_ports(self):
        self.assertEqual(v.mappings({'VAST_TCP_PORT_8384': '40617', 'VAST_UDP_PORT_4435': '40628',
                                    'VAST_TCP_PORT_72299': '40645', 'TOKEN': 'secret'}),
                         {'TCP': {8384: 40617}, 'UDP': {4435: 40628}})

    def test_source_fingerprint_catches_dirty_and_untracked_content(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subprocess.run(['git', 'init', '-q', directory], check=True)
            p = root / 'source.rs'; p.write_text('old')
            subprocess.run(['git', '-C', directory, 'add', 'source.rs'], check=True)
            first = v.source_hash(root, ['.'])
            p.write_text('new')
            second = v.source_hash(root, ['.'])
            (root / 'new.rs').write_text('untracked')
            self.assertNotEqual(first, second)
            self.assertNotEqual(second, v.source_hash(root, ['.']))

    def test_missing_wasm_invalidates_client_artifact(self):
        with tempfile.TemporaryDirectory() as directory:
            index = Path(directory) / 'index.html'; index.write_text('same index')
            wasm = Path(directory) / 'client.wasm'; wasm.write_bytes(b'wasm')
            first = v.artifact_hash(index, 'client')
            wasm.unlink()
            self.assertNotEqual(first, v.artifact_hash(index, 'client'))

    def test_pid_reuse_never_kills_the_new_owner(self):
        with patch.object(v, 'process_identity', return_value=['different', '456']), patch.object(v.os, 'kill') as kill:
            with self.assertRaisesRegex(RuntimeError, 'identity changed'):
                v.stop(123, ['old', '123'])
            kill.assert_not_called()

    def test_busy_match_refuses_before_any_mutation(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            d = dict(env={}, server=123, api=4005, udp=4435, ip='203.0.113.1', public_udp=12345)
            with patch.object(v, 'STATE', state), patch.object(v.Path, 'read_bytes', return_value=b'binary'), \
                 patch.object(v, 'process_identity', return_value=['old', '123']), \
                 patch.object(v, 'health', return_value={'players': 1}), patch.object(v.sp, 'run') as command, \
                 patch.object(v.os, 'kill') as kill:
                with self.assertRaisesRegex(RuntimeError, 'Players are connected'):
                    v.deploy(d, state / 'binary')
                command.assert_not_called(); kill.assert_not_called()

    def test_unknown_player_count_is_not_idle(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            d = dict(env={}, server=123, api=4005, udp=4435, ip='203.0.113.1', public_udp=12345)
            with patch.object(v, 'STATE', state), patch.object(v.Path, 'read_bytes', return_value=b'binary'), \
                 patch.object(v, 'process_identity', return_value=['old', '123']), \
                 patch.object(v, 'health', return_value={'status': 'ok'}), patch.object(v.os, 'kill') as kill:
                with self.assertRaisesRegex(RuntimeError, 'Players are connected'):
                    v.deploy(d, state / 'binary')
                kill.assert_not_called()

    def test_malformed_transport_path_fails_before_browser(self):
        d = dict(web=8384, ip='203.0.113.1', public_udp=40000)
        replies = [
            (b'<html></html>', {'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp'}),
            (json.dumps({'status': 'ok', 'physics_backend': 'physx_gpu'}).encode(), {}),
            (json.dumps({'url': 'https://203.0.113.1:40000/game/game'}).encode(), {}),
        ]
        with patch.object(v, 'fetch', side_effect=replies), patch.object(v.sp, 'run') as command:
            with self.assertRaisesRegex(RuntimeError, 'Advertised URL mismatch'):
                v.verify(d, browser=True)
            command.assert_not_called()


if __name__ == '__main__':
    unittest.main()
