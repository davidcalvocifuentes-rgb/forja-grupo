#!/bin/bash
# Usage: ./push.sh <github-token>
set -e
TOKEN="$1"
REPO_URL="https://davidcalvocifuentes-rgb:${TOKEN}@github.com/davidcalvocifuentes-rgb/forja-grupo.git"

echo "=== Creating GitHub repo ==="
curl -s -H "Authorization: token ${TOKEN}" \
  -H "Accept: application/vnd.github.v3+json" \
  https://api.github.com/user/repos \
  -d '{"name":"forja-grupo","description":"Forja Grupo - Accountability app","private":false}' | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('full_name',d.get('message','?')))"

cd /root/forja-grupo
echo "=== Git init ==="
git init
git add -A
git commit -m "Initial commit"

echo "=== Push ==="
git remote add origin "${REPO_URL}"
git branch -M main
git push -u origin main 2>&1

echo "=== DONE ==="
echo "https://github.com/davidcalvocifuentes-rgb/forja-grupo"