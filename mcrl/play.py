"""Run frozen bot duels or a human challenge. Never updates model weights."""
import argparse
import json
import signal
import time
from pathlib import Path

import numpy as np

from mcrl.policy import Policy
from mcrl.state import Arena, features, aim_features


def human_duels(env, aim, red, initial):
    human_name = initial['humanName']
    while True:
        state = env.request('/observe', {})
        if not state['humanOnline'] or state['players'][1]['health'] <= 0:
            time.sleep(.3)
            continue
        if not state['active'] and not state['ready']:
            if state['players'][1]['inventoryCount']:
                time.sleep(.5)
                continue
            state = env.request('/prepare', {})
        if state['ready']:
            if not state['startRequested']:
                time.sleep(.1)
                continue
            state = env.request('/begin', {})
        while state['active']:
            turn = aim.act(aim_features(state)[0])[0]
            move = red.act(features(state, 0))[0]
            state = env.step([move, 13], [turn, 3])
        if state['done']:
            print(json.dumps({'episode': state['episode'], 'terminal': state['terminal'],
                              'health': [p['health'] for p in state['players']]}), flush=True)
            winner = state['terminal'].get('winner')
            message = 'You win!' if winner == 1 else 'RedDQN wins.' if winner == 0 else 'Round ended.'
            message += ' Punch RedDQN when ready for another round.'
            env.request('/command', {'command': f'tellraw {human_name} {json.dumps({"text": message, "color": "gold"})}'})
            time.sleep(3)


def bot_duels(env, aim, red, rounds, seed):
    rng = np.random.default_rng(seed)
    for episode in range(rounds):
        state = env.request('/reset', {'phase': 'demo', 'maxSeconds': 45,
                            'distance': float(rng.uniform(4.5, 7.5)), 'angle': float(rng.uniform(-np.pi, np.pi)),
                            'yaws': rng.uniform(-180, 180, 2).tolist()})
        if any(p['health'] != 20 or p['inventoryCount'] for p in state['players']):
            raise RuntimeError('Both fighters must start healthy with empty inventories')
        while not state['done']:
            state = env.step(red.act([features(state, 0), features(state, 1)]), aim.act(aim_features(state)))
        print(json.dumps({'episode': episode + 1, 'terminal': state['terminal'],
                          'damage': [p['damageDealt'] for p in state['players']]}), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--models', type=Path, default=Path(__file__).resolve().parents[1] / 'models')
    parser.add_argument('--rounds', type=int, default=100)
    parser.add_argument('--seed', type=int, default=77)
    args = parser.parse_args()
    if args.rounds < 1:
        parser.error('--rounds must be positive')
    aim = Policy(args.models, 'aim', seed=args.seed)
    red = Policy(args.models, 'red', seed=args.seed + 1)
    env = Arena()
    initial = env.request('/state')
    print(json.dumps({'mode': initial.get('mode', 'bot_duels'), 'device': str(red.device),
                      'temperature': red.temperature, 'frozen': True}), flush=True)
    def interrupted(_signum, _frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, interrupted)
    try:
        if initial.get('mode') == 'human':
            human_duels(env, aim, red, initial)
        else:
            bot_duels(env, aim, red, args.rounds, args.seed)
    finally:
        try:
            env.request('/stop', {})
        except OSError:
            pass


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        pass
