import json
import re
import subprocess
from pathlib import Path

root = Path(__file__).resolve().parents[5]
script = Path(__file__).with_name('task-B05-serializer-benchmark.ts')
out = Path(__file__).with_name('new-benchmark-results.json')
cases = ['ascii', 'control', 'cjk-emoji', 'lone-surrogate', 'giant-key']
runs = []
for size in [1, 10, 50]:
    for case in cases:
        for mode in ['oracle', 'parse']:
            modes = [mode]
            repeats = 1
            for selected in modes:
                for repetition in range(repeats):
                    result = subprocess.run(['/usr/bin/time', '-l', 'bun', str(script), selected, case, str(size)], cwd=root, text=True, capture_output=True)
                    if result.returncode:
                        raise RuntimeError(f'{selected} {case} {size}: {result.stderr[:1000]}')
                    item = json.loads(result.stdout)
                    match = re.search(r'\s+(\d+)\s+maximum resident set size', result.stderr)
                    if not match:
                        raise RuntimeError(result.stderr[:1000])
                    item['osMaxRss'] = int(match.group(1))
                    item['repetition'] = repetition
                    runs.append(item)
        for repetition in range(3):
            for mode in ['native', 'candidate']:
                result = subprocess.run(['/usr/bin/time', '-l', 'bun', str(script), mode, case, str(size)], cwd=root, text=True, capture_output=True)
                if result.returncode:
                    raise RuntimeError(f'{mode} {case} {size} {repetition}: {result.stderr[:1000]}')
                item = json.loads(result.stdout)
                match = re.search(r'\s+(\d+)\s+maximum resident set size', result.stderr)
                if not match:
                    raise RuntimeError(result.stderr[:1000])
                item['osMaxRss'] = int(match.group(1))
                item['repetition'] = repetition
                runs.append(item)
        oracle = next(item for item in runs if item['mode'] == 'oracle' and item['kind'] == case and item['mib'] == size)
        for item in runs:
            if item['kind'] == case and item['mib'] == size and item['mode'] in ['native', 'candidate']:
                assert item['digest'] == oracle['digest']
                assert item['length'] == oracle['length'] == item['contentLength']
                assert 0 < item['maxChunk'] <= 65536
        out.write_text(json.dumps(runs, indent=2) + '\n')
        print(f'checked {size} MiB {case}: {len(runs)} processes', flush=True)
