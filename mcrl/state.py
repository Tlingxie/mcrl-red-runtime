import json
import math
from urllib.request import Request, urlopen

import numpy as np


class Arena:
    def __init__(self, url='http://127.0.0.1:3000'):
        self.url = url

    def request(self, path, data=None):
        body = None if data is None else json.dumps(data).encode()
        req = Request(self.url + path, data=body, headers={'Content-Type': 'application/json'})
        with urlopen(req, timeout=40) as response:
            return json.load(response)

    def step(self, moves, turns):
        return self.request('/step', {'actions': [{'move': int(m), 'turn': int(t)}
                                                for m, t in zip(moves, turns)], 'ms': 100})


def features(state, i=0):
    p, q = state['players'][i], state['players'][1 - i]
    x, z = p['position']['x'], p['position']['z']
    dx, dz = q['position']['x'] - x, q['position']['z'] - z
    d = max(.1, math.hypot(dx, dz))
    v, w = p.get('velocity') or {}, q.get('velocity') or {}
    vx, vz = v.get('x', 0), v.get('z', 0)
    rx, rz = w.get('x', 0) - vx, w.get('z', 0) - vz
    return np.array([
        min(p['distance'], 20) / 10, math.sin(p['aimError']), math.cos(p['aimError']),
        p['health'] / 20, q['health'] / 20, p['cooldown'], q['cooldown'],
        p['hurtCooldown'], q['hurtCooldown'], math.cos(q['aimError']),
        float(p['onGround']), float(q['onGround']),
        np.clip((rx * dx + rz * dz) / d / .5, -2, 2),
        np.clip((rx * dz - rz * dx) / d / .5, -2, 2),
        np.clip((q['position']['y'] - p['position']['y']) / 2, -2, 2),
        min(math.hypot(vx, vz) / .5, 2), (21 - max(abs(x), abs(z))) / 21,
        (p['health'] - q['health']) / 20,
    ], dtype=np.float32)


def aim_features(state):
    return [[math.sin(p['aimError']), math.cos(p['aimError'])] for p in state['players']]
