import argparse
import hashlib
import json
from pathlib import Path

from huggingface_hub import hf_hub_download

ROOT = Path(__file__).resolve().parents[1]


def download(destination=ROOT / 'models'):
    spec = json.loads((ROOT / 'model-source.json').read_text())
    if not spec['repo_id'] or not spec['revision']:
        raise RuntimeError('The model source has not been configured')
    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=True)
    for filename, expected in spec['files'].items():
        if Path(filename).name != filename:
            raise ValueError('Invalid model filename')
        path = destination / filename
        if path.is_file() and hashlib.sha256(path.read_bytes()).hexdigest() == expected:
            continue
        hf_hub_download(repo_id=spec['repo_id'], filename=filename, revision=spec['revision'], local_dir=destination)
        if hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            raise ValueError(f'Model download checksum mismatch: {filename}')
    print(f'Frozen model verified: {destination}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--destination', type=Path, default=ROOT / 'models')
    download(parser.parse_args().destination)
