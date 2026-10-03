import json
import os
import tempfile
import unittest
from pathlib import Path
from shutil import copyfile

import numpy as np

from mcrl.policy import Policy

ROOT = Path(__file__).resolve().parents[1]
MODELS = Path(os.environ.get('MCRL_MODEL_DIR', ROOT / 'models'))


class FrozenPolicyTests(unittest.TestCase):
    def test_matches_original_float32_network(self):
        reference = json.loads((ROOT / 'tests/policy-reference.json').read_text())
        for kind, sample in reference.items():
            model = Policy(MODELS, kind)
            np.testing.assert_allclose(model.values(sample['observations']), sample['q_values'], rtol=2e-5, atol=2e-5)
            self.assertTrue(all(not a.flags.writeable for a in model.weights.values()))
            self.assertFalse(hasattr(model, 'optimizer'))

    def test_nonfinite_or_wrong_shape_is_rejected(self):
        model = Policy(MODELS)
        with self.assertRaises(ValueError):
            model.act([float('nan')] * 18)
        with self.assertRaises(ValueError):
            model.act([0, 0])

    def test_tampered_weights_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            copyfile(MODELS / 'config.json', directory / 'config.json')
            (directory / 'red.safetensors').write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError, 'checksum'):
                Policy(directory)

    def test_seed_reproduces_stochastic_actions(self):
        a, b = Policy(MODELS, seed=37), Policy(MODELS, seed=37)
        obs = np.zeros((32, 18), dtype=np.float32)
        np.testing.assert_array_equal(a.act(obs), b.act(obs))


if __name__ == '__main__':
    unittest.main()
