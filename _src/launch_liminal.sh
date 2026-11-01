#!/usr/bin/env bash
# Put the latest tested Liminal installer on masterscope.gwstudio.com.au and switch
# every "coming soon" on the site to the download.
#   ./launch_liminal.sh            stage, build and test locally (no push)
#   ./launch_liminal.sh --push     ...and publish
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SITE="$(cd "$(dirname "$0")/.." && pwd)"
LIM=${LIM:-/home/claude/liminal-repo}
ESBUILD=${ESBUILD:-/opt/npm-tools/node_modules/@esbuild/linux-x64/bin/esbuild}

# 1. The installer CI published to the Liminal repo's dist branch (passed pluginval)
git -C "$LIM" fetch -q origin dist
TMP=$(mktemp -d)
git -C "$LIM" archive origin/dist | tar -x -C "$TMP"
python3 - "$TMP" "$SITE/downloads" <<'PY'
import hashlib, json, os, shutil, sys
tmp, dest = sys.argv[1], sys.argv[2]
r = json.load(open(os.path.join(tmp, 'release.json'), encoding='utf-8-sig'))
files = r.get('files') or {'suite': {'setup': r['setup'], 'sha256': r['sha256'], 'bytes': r['bytes']}}
os.makedirs(dest, exist_ok=True)
for k, f in files.items():
    data = open(os.path.join(tmp, f['setup']), 'rb').read()
    assert hashlib.sha256(data).hexdigest() == f['sha256'], f'checksum mismatch: {f["setup"]}'
    assert len(data) == f['bytes'], f'size mismatch: {f["setup"]}'
    shutil.copy(os.path.join(tmp, f['setup']), dest)
    print('verified', k, f['setup'], f['bytes'], 'bytes')
print('commit', r['commit'][:7])
PY

# 2. Record the release
python3 - "$TMP/release.json" "$HERE/release.json" <<'PY'
import datetime, json, sys
r = json.load(open(sys.argv[1], encoding='utf-8-sig'))
d = datetime.date.today()
r['date'] = f'{d.day} {d:%B %Y}'; r['iso_date'] = d.isoformat()
json.dump(r, open(sys.argv[2], 'w'), indent=2)
print('release', r['version'], r['date'])
PY
rm -rf "$TMP"

# 3. Build and test
cd "$HERE"
ESBUILD="$ESBUILD" python3 build_site.py "$SITE"
grep -q 'Download for Windows' "$SITE/liminal/index.html"
! grep -q 'Downloads are coming soon' "$SITE/liminal/index.html"
python3 full_test.py | tail -1

# 4. Publish
if [ "${1:-}" = "--push" ]; then
  cd "$SITE"
  git add -A
  V=$(python3 -c "import json;print(json.load(open('$HERE/release.json'))['version'])")
  git commit -qm "Liminal $V for Windows: download live" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QMxkR41z4R4Uaybvt62sQa"
  git push -q origin main
  echo "pushed"
else
  echo "staged locally; run with --push to publish"
fi
