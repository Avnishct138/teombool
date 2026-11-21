#!/usr/bin/env bash
# Local end-to-end check of the AGNi Development Assistant API.
# usage: ask.sh "<message>" [base]
set -euo pipefail
BASE="${2:-http://127.0.0.1:8788}"
MSG="$1"

CH=$(curl -sS --max-time 30 -X POST "$BASE/api/agni/assistant/challenge" -H 'content-type: application/json' -d '{}')
ID=$(python3 -c "import json,sys;print(json.loads(sys.argv[1])['id'])" "$CH")
Q=$(python3 -c "import json,sys;print(json.loads(sys.argv[1])['question'])" "$CH")
ANS=$(python3 -c "import re,sys; a,b=map(int,re.findall(r'\d+',sys.argv[1])); print(a+b)" "$Q")

python3 - "$MSG" "$ID" "$ANS" > /tmp/_req.json <<'PYEOF'
import json, sys
msg, cid, ans = sys.argv[1], sys.argv[2], sys.argv[3]
w1 = [[0.1, 0.2, 0.3, 0.4] for _ in range(16)]
w2 = [[0.05] * 16 for _ in range(3)]
context = {
    "page": "agni-lab",
    "model": {"architecture": "4-16-3", "hiddenActivation": "relu", "outputActivation": "softmax"},
    "inputs": [1, 0, 1, 0],
    "weights": {"w1": w1, "b1": [0.0] * 16, "w2": w2, "b2": [0, 0, 0]},
    "projectState": {"section": "playground", "hasRun": True, "dirty": False},
}
print(json.dumps({
    "message": msg,
    "challenge": {"id": cid, "answer": ans},
    "page": "agni-lab",
    "teachingMode": True,
    "context": context,
}))
PYEOF

curl -sS --max-time 120 -X POST "$BASE/api/agni/assistant/chat" \
  -H 'content-type: application/json' -d @/tmp/_req.json -o /tmp/_res.json -w "chat HTTP %{http_code}\n"

python3 - <<'PYEOF'
import json
d = json.load(open('/tmp/_res.json'))
print('reply   :', (d.get('reply') or d.get('error') or '')[:500].replace('\n', ' '))
print('tools   :', [(t['name'], t['status'], t.get('ms')) for t in d.get('toolCalls', [])])
print('errors  :', d.get('errors'))
p = d.get('proposal')
print('proposal:', {k: p[k] for k in ('id', 'kind', 'title', 'summary')} if p else None)
if p:
    print('diff    :', len(p['diff']), 'rows →', p['diff'][:2])
    open('/tmp/_pid', 'w').write(p['id'])
PYEOF
