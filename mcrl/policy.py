"""Small, frozen float32 MLPs using NumPy. No training or accelerator runtime."""
import hashlib
import json
from pathlib import Path

import numpy as np
from safetensors.numpy import load_file


class Policy:
    def __init__(self, directory, kind='red', seed=7):
        directory = Path(directory)
        config = json.loads((directory / 'config.json').read_text())
        spec = config['networks'][kind]
        filename = spec['file']
        if Path(filename).name != filename:
            raise ValueError('Model weights must be a plain filename')
        weights = directory / filename
        digest = hashlib.sha256(weights.read_bytes()).hexdigest()
        if digest != spec['sha256']:
            raise ValueError(f'Weight checksum mismatch: {filename}')
        self.device = 'cpu/numpy'
        self.obs_dim = spec['observations']
        self.n_actions = spec['actions']
        self.temperature = spec.get('temperature', 0)
        hidden = spec['hidden']
        self.weights = load_file(str(weights))
        expected = {'0.weight': (hidden, self.obs_dim), '0.bias': (hidden,),
                    '2.weight': (hidden, hidden), '2.bias': (hidden,),
                    '4.weight': (self.n_actions, hidden), '4.bias': (self.n_actions,)}
        if set(self.weights) != set(expected):
            raise ValueError('Unexpected model tensors')
        for key, shape in expected.items():
            array = self.weights[key]
            if array.shape != shape or array.dtype != np.float32 or not np.isfinite(array).all():
                raise ValueError(f'Invalid tensor: {key}')
            array.setflags(write=False)
        self.rng = np.random.default_rng(seed)

    def values(self, observations):
        array = np.asarray(observations, dtype=np.float32)
        if array.ndim == 1:
            array = array[None, :]
        if array.ndim != 2 or array.shape[1] != self.obs_dim or not np.isfinite(array).all():
            raise ValueError(f'Expected finite observations with shape (N, {self.obs_dim})')
        for layer in ('0', '2', '4'):
            array = array @ self.weights[f'{layer}.weight'].T + self.weights[f'{layer}.bias']
            if layer != '4':
                np.maximum(array, 0, out=array)
        return array

    def act(self, observations):
        q = self.values(observations)
        if not self.temperature:
            return q.argmax(axis=1)
        shifted = (q - q.max(axis=1, keepdims=True)) / self.temperature
        probabilities = np.exp(shifted).astype(np.float64)
        probabilities /= probabilities.sum(axis=1, keepdims=True)
        return np.array([self.rng.choice(self.n_actions, p=p) for p in probabilities])
