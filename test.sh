#!/usr/bin/env bash
# End-to-end smoke test for forge (main.ts). Starts the server on a scratch
# data dir, exercises REST + git smart HTTP + GraphQL + MCP + webhooks.
set -u
cd "$(dirname "$0")"

PORT=18099
HOOK_PORT=18098
TOKEN="forge-secret-token"
BASE="http://127.0.0.1:$PORT"
DATA="/tmp/forge-test-data"
BODY=/tmp/forge-test-body.json
HOOKLOG=/tmp/forge-test-hooks.log
PASS=0; FAIL=0
SERVER_PID=""; HOOK_PID=""; EPH_PID=""

ok() { # ok <expected> <actual> <label>
  if [ "$1" = "$2" ]; then PASS=$((PASS+1)); echo "PASS: $3";
  else FAIL=$((FAIL+1)); echo "FAIL: $3 (expected '$1', got '$2')"; fi
}
contains() { # contains <file> <needle> <label>
  if grep -qF "$2" "$1" 2>/dev/null; then PASS=$((PASS+1)); echo "PASS: $3";
  else FAIL=$((FAIL+1)); echo "FAIL: $3 (missing '$2' in $1)"; fi
}
not_contains() { # not_contains <file> <needle> <label>
  if grep -qF -- "$2" "$1" 2>/dev/null; then FAIL=$((FAIL+1)); echo "FAIL: $3 (unexpected '$2' in $1)";
  else PASS=$((PASS+1)); echo "PASS: $3"; fi
}
code() { # code <curl args...> — sets $CODE, body in $BODY
  CODE=$(curl -s -o "$BODY" -w "%{http_code}" "$@")
}
cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null
  [ -n "$HOOK_PID" ] && kill "$HOOK_PID" 2>/dev/null
  [ -n "$EPH_PID" ] && kill "$EPH_PID" 2>/dev/null
  wait 2>/dev/null
}
trap cleanup EXIT

rm -rf "$DATA" /tmp/forge-clone1 /tmp/forge-clone2 "$HOOKLOG" /tmp/forge-test-data2
export GIT_CONFIG_NOSYSTEM=1
git config --global --add safe.directory '*' 2>/dev/null || true

# --- webhook receiver -------------------------------------------------------
HOOKLOG="$HOOKLOG" HOOK_PORT=$HOOK_PORT node -e 'require("http").createServer((req,res)=>{let b="";req.on("data",c=>b+=c);req.on("end",()=>{require("fs").appendFileSync(process.env.HOOKLOG, (req.headers["x-github-event"]||"?")+":"+b+"\n");res.end("ok")})}).listen(Number(process.env.HOOK_PORT))' &
HOOK_PID=$!

# --- start server -----------------------------------------------------------
FORGE_DATA_DIR="$DATA" PORT=$PORT node main.ts > /tmp/forge-test-server.log 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 50); do
  sleep 0.2
  if curl -s -o /dev/null "$BASE/" 2>/dev/null; then break; fi
done

echo "== basic =="
code "$BASE/"
ok 200 "$CODE" "GET / returns 200"
code -X POST "$BASE/api/v3/user/repos" -H 'Content-Type: application/json' -d '{"name":"demo"}'
ok 401 "$CODE" "POST /user/repos without auth -> 401"

echo "== repos =="
code -X POST "$BASE/api/v3/user/repos" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"name":"demo","description":"demo repo"}'
ok 201 "$CODE" "POST /user/repos with auth -> 201"
contains "$BODY" '"full_name":"forge/demo"' "repo full_name is forge/demo"
code -X POST "$BASE/api/v3/user/repos" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"name":"demo"}'
ok 422 "$CODE" "duplicate repo -> 422"
code -X POST "$BASE/api/v3/user/repos" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"name":"../evil"}'
ok 422 "$CODE" "path-traversal repo name -> 422"
code "$BASE/api/v3/repos/forge/demo"
ok 200 "$CODE" "GET repo -> 200"
code -X PATCH "$BASE/api/v3/repos/forge/demo" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"description":"updated desc"}'
ok 200 "$CODE" "PATCH repo -> 200"
contains "$BODY" '"description":"updated desc"' "PATCH repo updated description"
code "$BASE/api/v3/repos"
ok 200 "$CODE" "GET /repos -> 200"
contains "$BODY" 'forge/demo' "repo list contains demo"

echo "== git smart HTTP round-trip =="
git clone -q "$BASE/forge/demo.git" /tmp/forge-clone1 2>/tmp/forge-clone1.log
ok 0 "$?" "git clone empty repo"
printf 'hello forge\n' > /tmp/forge-clone1/hello.txt
git -C /tmp/forge-clone1 add hello.txt
git -C /tmp/forge-clone1 -c user.name=test -c user.email=t@t commit -qm "add hello"
# NOTE: an empty-repo clone checks out unborn `master`; push HEAD explicitly to main.
git -C /tmp/forge-clone1 push -q "http://forge:$TOKEN@127.0.0.1:$PORT/forge/demo.git" HEAD:refs/heads/main 2>/tmp/forge-push1.log
ok 0 "$?" "git push first commit (auth)"
git clone -q "$BASE/forge/demo.git" /tmp/forge-clone2 2>/tmp/forge-clone2.log
ok 0 "$?" "git clone after push"
contains /tmp/forge-clone2/hello.txt "hello forge" "cloned repo contains hello.txt"
printf 'hello forge v2\n' > /tmp/forge-clone2/hello.txt
git -C /tmp/forge-clone2 -c user.name=test -c user.email=t@t commit -qam "update hello"
git -C /tmp/forge-clone2 push -q "http://forge:$TOKEN@127.0.0.1:$PORT/forge/demo.git" main 2>/tmp/forge-push2.log
ok 0 "$?" "git push second commit"
git -C /tmp/forge-clone1 fetch -q origin 2>/tmp/forge-fetch.log
ok 0 "$?" "git fetch in first clone"
git -C /tmp/forge-clone1 checkout -q main 2>/tmp/forge-checkout.log
ok 0 "$?" "git checkout main in first clone"
git -C /tmp/forge-clone1 pull -q 2>/tmp/forge-pull.log
ok 0 "$?" "git pull in first clone"
contains /tmp/forge-clone1/hello.txt "hello forge v2" "pull brought v2 content"
git -C /tmp/forge-clone1 ls-remote "$BASE/forge/demo.git" >/tmp/forge-lsremote.log 2>&1
ok 0 "$?" "git ls-remote works"
contains /tmp/forge-lsremote.log "refs/heads/main" "ls-remote lists main"

echo "== contents =="
code "$BASE/api/v3/repos/forge/demo/contents/hello.txt"
ok 200 "$CODE" "GET contents hello.txt -> 200"
contains "$BODY" "$(printf 'hello forge v2\n' | base64 -w0)" "contents base64 matches"
B64_API=$(printf 'via api\n' | base64 -w0)
code -X PUT "$BASE/api/v3/repos/forge/demo/contents/api.txt" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "{\"message\":\"add api.txt\",\"content\":\"$B64_API\"}"
ok 201 "$CODE" "PUT contents api.txt -> 201"
code "$BASE/api/v3/repos/forge/demo/contents/api.txt"
ok 200 "$CODE" "GET contents api.txt -> 200"
code "$BASE/api/v3/repos/forge/demo/contents/..%2Fstore.json"
ok 400 "$CODE" "contents path traversal -> 400"
# directory listing lists children, not the tree itself
B64_CFG=$(printf 'cfg\n' | base64 -w0)
code -X PUT "$BASE/api/v3/repos/forge/demo/contents/config/one.txt" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "{\"message\":\"add one.txt\",\"content\":\"$B64_CFG\"}"
ok 201 "$CODE" "PUT contents config/one.txt -> 201"
code "$BASE/api/v3/repos/forge/demo/contents/config"
ok 200 "$CODE" "GET contents config (directory) -> 200"
contains "$BODY" "one.txt" "directory listing has one.txt"
# stale sha on PUT contents -> 409, and PUT response carries blob sha + encoding
code -X PUT "$BASE/api/v3/repos/forge/demo/contents/api.txt" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "{\"message\":\"stale\",\"content\":\"$B64_API\",\"sha\":\"0000000000000000000000000000000000000000\"}"
ok 409 "$CODE" "PUT contents with stale sha -> 409"
code -X PUT "$BASE/api/v3/repos/forge/demo/contents/api2.txt" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "{\"message\":\"add api2.txt\",\"content\":\"$B64_API\"}"
ok 201 "$CODE" "PUT contents api2.txt -> 201"
contains "$BODY" '"encoding":"base64"' "PUT contents response has encoding base64"
code "$BASE/api/v3/repos/forge/demo/commits"
ok 200 "$CODE" "GET commits -> 200"
contains "$BODY" "add hello" "commits list has first commit"
python3 -c "
import json
msgs=[c['commit']['message'] for c in json.load(open('$BODY'))]
assert msgs and all(chr(31) not in m and 'forge@localhost' not in m for m in msgs), msgs
print('commit messages ok:', msgs[:2])
" && PASS=$((PASS+1)) && echo "PASS: commit message is the message, not the log line" || { FAIL=$((FAIL+1)); echo "FAIL: commit message is the message, not the log line"; }
code "$BASE/api/v3/repos/forge/demo/git/refs"
ok 200 "$CODE" "GET git refs -> 200"
contains "$BODY" "refs/heads/main" "refs list has main"
code "$BASE/api/v3/repos/forge/demo/branches"
ok 200 "$CODE" "GET branches -> 200"

echo "== issues =="
code -X POST "$BASE/api/v3/repos/forge/demo/issues" -H 'Content-Type: application/json' -d '{"title":"no auth"}'
ok 401 "$CODE" "POST issue without auth -> 401"
code -X POST "$BASE/api/v3/repos/forge/demo/issues" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"title":"first bug","body":"it broke","labels":["bug"]}'
ok 201 "$CODE" "POST issue -> 201"
contains "$BODY" '"number":1' "issue number is 1"
code "$BASE/api/v3/repos/forge/demo/issues"
ok 200 "$CODE" "GET issues -> 200"
contains "$BODY" "first bug" "issues list has first bug"
# sort=created&direction=desc lists the newest first even within one ms
for t in sort-a sort-b sort-c; do
  code -X POST "$BASE/api/v3/repos/forge/demo/issues" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "{\"title\":\"$t\"}"
done
code "$BASE/api/v3/repos/forge/demo/issues?sort=created&direction=desc"
python3 -c "
import json,sys
titles=[i['title'] for i in json.load(open('$BODY'))]
assert titles[:3]==['sort-c','sort-b','sort-a'], titles[:3]
print('issues desc order ok:', titles[:3])
" && PASS=$((PASS+1)) && echo "PASS: issues sort desc is newest first" || { FAIL=$((FAIL+1)); echo "FAIL: issues sort desc is newest first"; }
code -X PATCH "$BASE/api/v3/repos/forge/demo/issues/1" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"state":"closed"}'
ok 200 "$CODE" "PATCH issue close -> 200"
contains "$BODY" '"state":"closed"' "issue is closed"
code -X POST "$BASE/api/v3/repos/forge/demo/issues/1/comments" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"body":"looking into it"}'
ok 201 "$CODE" "POST issue comment -> 201"
code "$BASE/api/v3/repos/forge/demo/issues/1/comments"
ok 200 "$CODE" "GET issue comments -> 200"
contains "$BODY" "looking into it" "comment listed"

echo "== pull requests =="
git -C /tmp/forge-clone1 checkout -qb feature
printf 'feature work\n' > /tmp/forge-clone1/feature.txt
git -C /tmp/forge-clone1 add feature.txt
git -C /tmp/forge-clone1 -c user.name=test -c user.email=t@t commit -qm "add feature"
git -C /tmp/forge-clone1 push -q "http://forge:$TOKEN@127.0.0.1:$PORT/forge/demo.git" HEAD:refs/heads/feature 2>/tmp/forge-push3.log
ok 0 "$?" "git push feature branch"
code -X POST "$BASE/api/v3/repos/forge/demo/pulls" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"title":"add feature","head":"feature","base":"main","body":"please merge"}'
ok 201 "$CODE" "POST pull request -> 201"
contains "$BODY" '"number":1' "PR number is 1"
code "$BASE/api/v3/repos/forge/demo/pulls"
ok 200 "$CODE" "GET pulls -> 200"
code "$BASE/api/v3/repos/forge/demo/pulls/1/files"
ok 200 "$CODE" "GET PR files -> 200"
contains "$BODY" "feature.txt" "PR files include feature.txt"
code -X PUT "$BASE/api/v3/repos/forge/demo/pulls/1/merge" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{}'
ok 200 "$CODE" "PUT merge PR -> 200"
contains "$BODY" '"merged":true' "PR merged"
code "$BASE/api/v3/repos/forge/demo/contents/feature.txt"
ok 200 "$CODE" "merged file visible on main via contents"

echo "== webhooks =="
code -X POST "$BASE/api/v3/repos/forge/demo/hooks" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "{\"config\":{\"url\":\"http://127.0.0.1:$HOOK_PORT/hook\",\"content_type\":\"json\"},\"events\":[\"issues\",\"push\",\"pull_request\"]}"
ok 201 "$CODE" "POST webhook -> 201"
code -X POST "$BASE/api/v3/repos/forge/demo/issues" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"title":"hook test"}'
ok 201 "$CODE" "POST issue (hook trigger) -> 201"
sleep 1
contains "$HOOKLOG" "issues:" "webhook received issues event"
code -X POST "$BASE/api/v3/repos/forge/demo/hooks/1/pings" -H "Authorization: Bearer $TOKEN"
ok 204 "$CODE" "POST hook ping -> 204"
sleep 1
contains "$HOOKLOG" "ping:" "webhook received ping event"
code "$BASE/api/v3/repos/forge/demo/hooks/1/deliveries"
ok 200 "$CODE" "GET hook deliveries -> 200"
code -X DELETE "$BASE/api/v3/repos/forge/demo/hooks/1" -H "Authorization: Bearer $TOKEN"
ok 204 "$CODE" "DELETE webhook -> 204"

echo "== graphql =="
code -X POST "$BASE/graphql" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"query":"query { repository(owner: \"forge\", name: \"demo\") { name description issues { totalCount } } }"}'
ok 200 "$CODE" "GraphQL repository query -> 200"
contains "$BODY" '"name":"demo"' "GraphQL returns repo"
code -X POST "$BASE/graphql" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"query":"mutation($input: CreateIssueInput!) { createIssue(input: $input) { issue { number title } } }","variables":{"input":{"repositoryId":"repo:forge/demo","title":"gql issue","body":"via graphql"}}}'
ok 200 "$CODE" "GraphQL createIssue -> 200"
contains "$BODY" '"title":"gql issue"' "GraphQL created issue"
code -X POST "$BASE/graphql" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"query":"query { viewer { login } }"}'
ok 200 "$CODE" "GraphQL viewer -> 200"
code -X POST "$BASE/graphql" -H 'Content-Type: application/json' -d '{"query":"query { viewer { login } }"}'
ok 401 "$CODE" "GraphQL without auth -> 401"
code -X POST "$BASE/graphql" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"query":"query { Issue: __type(name: \"Issue\") { fields(includeDeprecated: true) { name } } }"}'
ok 200 "$CODE" "GraphQL __type Issue introspection -> 200"
contains "$BODY" '"name":"title"' "introspection lists Issue.title"
code -X POST "$BASE/graphql" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '[{"query":"query { viewer { login } }"},{"query":"query { Issue: __type(name: \"Issue\") { fields(includeDeprecated: true) { name } } }"}]'
ok 200 "$CODE" "GraphQL batched operations -> 200"
contains "$BODY" '"login":"forge"' "batch first result is viewer"
code -X POST "$BASE/graphql" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"query":"query { viewer { login noSuchFieldOnViewer } }"}'
ok 200 "$CODE" "GraphQL unknown field -> 200 with errors"
contains "$BODY" 'noSuchFieldOnViewer' "unknown-field error names the field"

echo "== mcp =="
code -X POST "$BASE/mcp" -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}'
ok 200 "$CODE" "MCP initialize -> 200"
contains "$BODY" "forge" "MCP serverInfo is forge"
code -X POST "$BASE/mcp" -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
ok 200 "$CODE" "MCP tools/list -> 200"
contains "$BODY" "create_repository" "MCP lists create_repository"
code -X POST "$BASE/mcp" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"create_repository","arguments":{"name":"mcp-repo"}}}'
ok 200 "$CODE" "MCP create_repository -> 200"
contains "$BODY" "mcp-repo" "MCP created repo"
code -X POST "$BASE/mcp" -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"create_repository","arguments":{"name":"nope"}}}'
ok 401 "$CODE" "MCP unauthenticated tools/call -> 401"
code -X POST "$BASE/mcp" -H 'Content-Type: application/json' --data-binary '{not json'
ok 400 "$CODE" "MCP malformed JSON -> 400"
contains "$BODY" '32700' "MCP malformed JSON carries -32700"
code -X POST "$BASE/mcp" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"list_repositories","arguments":{}}}'
ok 200 "$CODE" "MCP list_repositories -> 200"
contains "$BODY" "mcp-repo" "MCP lists the created repo"

echo "== trial-surface: healthz, meta, headers, pagination, labels =="
code "$BASE/healthz"
ok 200 "$CODE" "GET /healthz -> 200"
contains "$BODY" '"ok":true' "healthz answers {ok:true}"
code "$BASE/api/v3/meta"
ok 200 "$CODE" "GET /api/v3/meta -> 200"
contains "$BODY" '"installed_version":"1.0.0"' "meta reports installed_version"
curl -s -D /tmp/forge-test-headers.txt -o /dev/null "$BASE/api/v3/"
contains /tmp/forge-test-headers.txt "X-OAuth-Scopes: repo, read:org" "GET /api/v3/ carries X-OAuth-Scopes"
contains /tmp/forge-test-headers.txt "X-GitHub-Request-Id:" "GET /api/v3/ carries X-GitHub-Request-Id"
code -X POST "$BASE/api/v3/user/repos" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"name":"page-a"}'
ok 201 "$CODE" "POST page-a repo -> 201"
code -X POST "$BASE/api/v3/user/repos" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"name":"page-b"}'
ok 201 "$CODE" "POST page-b repo -> 201"
curl -s -D /tmp/forge-test-page1.txt -o "$BODY" "$BASE/api/v3/user/repos?per_page=2&page=1"
contains /tmp/forge-test-page1.txt 'rel="next"' "page 1 Link header has rel=next"
contains /tmp/forge-test-page1.txt "page=2" "page 1 Link points at page 2"
code -X POST "$BASE/api/v3/repos/forge/demo/labels" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"name":"bug","color":"ededed"}'
ok 201 "$CODE" "POST /labels bug (default label) -> 201"
code -X POST "$BASE/api/v3/repos/forge/demo/issues" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"title":"bad label","labels":["no-such-label-xyz"]}'
ok 422 "$CODE" "POST issue with unknown label -> 422"
code -X POST "$BASE/api/v3/repos/forge/demo/issues" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"title":"good label","labels":["bug"]}'
ok 201 "$CODE" "POST issue with existing label -> 201"

echo "== misc / security =="
code "$BASE/api/v3/search/repositories?q=demo"
ok 200 "$CODE" "search repositories -> 200"
contains "$BODY" "forge/demo" "search finds demo"
code "$BASE/api/v3/nonexistent"
ok 404 "$CODE" "unknown route -> 404"
code -X DELETE "$BASE/api/v3/repos/forge/demo" -H 'Content-Type: application/json'
ok 401 "$CODE" "DELETE repo without auth -> 401"
code "$BASE/api/v3/export"
ok 200 "$CODE" "GET export -> 200"
cp "$BODY" /tmp/forge-export1.json
code "$BASE/api/v3/export"
cp "$BODY" /tmp/forge-export2.json
if cmp -s /tmp/forge-export1.json /tmp/forge-export2.json; then PASS=$((PASS+1)); echo "PASS: export is deterministic (identical bytes)"; else FAIL=$((FAIL+1)); echo "FAIL: export differs between runs"; fi

echo "== ephemeral port + Node 22 flag =="
FORGE_DATA_DIR=/tmp/forge-test-data2 node --experimental-strip-types main.ts > /tmp/forge-test-eph.log 2>&1 &
EPH_PID=$!
sleep 1
EPH_PORT=$(grep -o 'FORGE_PORT=[0-9]*' /tmp/forge-test-eph.log | head -1 | cut -d= -f2)
if [ -n "$EPH_PORT" ] && [ "$EPH_PORT" != "8080" ]; then PASS=$((PASS+1)); echo "PASS: ephemeral port mode (port $EPH_PORT, not 8080)"; else FAIL=$((FAIL+1)); echo "FAIL: ephemeral port mode (got '$EPH_PORT')"; fi
code "http://127.0.0.1:$EPH_PORT/"
ok 200 "$CODE" "ephemeral-port server answers"

echo
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
