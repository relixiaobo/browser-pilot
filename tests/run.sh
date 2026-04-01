#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BP="node $PROJECT_DIR/dist/cli.js"
PORT=18273
URL="http://127.0.0.1:$PORT"
PASS=0; FAIL=0; SKIP=0; ERRORS=""

# ── Helpers ────────────────────────────────────────

jf() { node -e "try{const d=JSON.parse(process.argv[1]);const v=process.argv[2].split('.').reduce((o,k)=>o?.[k],d);console.log(typeof v==='object'?JSON.stringify(v):String(v??''))}catch{console.log('')}" "$1" "$2"; }
jok()  { [[ "$(jf "$1" ok)" == "true" ]]; }
jnok() { [[ "$(jf "$1" ok)" == "false" ]]; }
jhas() { [[ "$(jf "$1" "$2")" == *"$3"* ]]; }
jlen() { node -e "try{console.log(JSON.parse(process.argv[1]).$2?.length??0)}catch{console.log(0)}" "$1" "$2"; }
get_ref() { node -e "const d=JSON.parse(process.argv[1]);const e=d.elements?.find(e=>e.name?.includes(process.argv[2]));console.log(e?.ref??'')" "$1" "$2"; }

run_test() {
  local name="$1"; shift
  if "$@" 2>/dev/null; then
    PASS=$((PASS+1)); printf "  \033[32m✓\033[0m %s\n" "$name"
  else
    FAIL=$((FAIL+1)); ERRORS="$ERRORS\n  ✗ $name"
    printf "  \033[31m✗\033[0m %s\n" "$name"
  fi
}

# ── Build ──────────────────────────────────────────

echo "Building..."
(cd "$PROJECT_DIR" && npm run build --silent) || { echo "Build failed"; exit 1; }

# ── Start test server ──────────────────────────────

echo "Starting test server on port $PORT..."
node "$SCRIPT_DIR/server.mjs" $PORT &
SERVER_PID=$!
sleep 1

# ── Cleanup ────────────────────────────────────────

cleanup() {
  $BP disconnect 2>/dev/null || true
  kill $SERVER_PID 2>/dev/null || true
  rm -f /tmp/bp-test-* screenshot-*.png page-*.pdf
}
trap cleanup EXIT

# ── Connect ────────────────────────────────────────

echo "Connecting to Chrome..."
echo "(If prompted, click Allow in Chrome's dialog)"
OUT=$($BP connect 2>&1)
if ! jok "$OUT"; then
  echo "Failed to connect: $OUT"
  exit 1
fi
echo "Connected."
echo ""

# ── Enable network monitoring early ────────────────

$BP net 2>/dev/null

# ═══════════════════════════════════════════════════
# TESTS
# ═══════════════════════════════════════════════════

echo "── Lifecycle ──"

test_disconnect_reconnect() {
  $BP disconnect 2>/dev/null
  local out=$($BP connect 2>&1)
  jok "$out"
}
run_test "disconnect + reconnect" test_disconnect_reconnect

echo ""
echo "── Navigation ──"

test_open_basic() {
  local out=$($BP open "$URL/" 2>&1)
  jok "$out" && jhas "$out" title "BP Test Page" && [[ $(jlen "$out" elements) -gt 0 ]]
}
run_test "open returns snapshot with title and elements" test_open_basic

test_open_limit() {
  local out=$($BP open "$URL/many" --limit 5 2>&1)
  jok "$out" && [[ $(jlen "$out" elements) -le 5 ]]
}
run_test "open --limit caps elements" test_open_limit

test_open_new_tab() {
  $BP open "$URL/" 2>/dev/null
  $BP open "$URL/page2" --new 2>/dev/null
  local out=$($BP tabs 2>&1)
  [[ $(jlen "$out" tabs) -ge 2 ]]
}
run_test "open --new creates new tab" test_open_new_tab

test_open_empty() {
  # close extra tabs first
  $BP close --all 2>/dev/null; $BP connect 2>/dev/null
  local out=$($BP open "$URL/empty" 2>&1)
  # Page has no interactive elements, but browser extensions may inject accessible elements
  jok "$out" && [[ $(jlen "$out" elements) -le 1 ]]
}
run_test "open empty page has minimal elements" test_open_empty

echo ""
echo "── Snapshot ──"

test_snapshot_basic() {
  $BP open "$URL/" 2>/dev/null
  local out=$($BP snapshot 2>&1)
  jok "$out" && [[ $(jlen "$out" elements) -gt 0 ]]
}
run_test "snapshot returns elements" test_snapshot_basic

test_snapshot_limit() {
  $BP open "$URL/many" 2>/dev/null
  local out=$($BP snapshot --limit 3 2>&1)
  [[ $(jlen "$out" elements) -eq 3 ]]
}
run_test "snapshot --limit 3 returns exactly 3" test_snapshot_limit

test_snapshot_ref_1based() {
  $BP open "$URL/" 2>/dev/null
  local out=$($BP snapshot 2>&1)
  [[ "$(jf "$out" 'elements.0.ref')" == "1" ]]
}
run_test "snapshot refs are 1-based" test_snapshot_ref_1based

echo ""
echo "── Click ──"

test_click_ref() {
  local snap=$($BP open "$URL/" 2>&1)
  local ref=$(get_ref "$snap" "Click Me")
  [[ -n "$ref" ]] || return 1
  local out=$($BP click "$ref" 2>&1)
  jok "$out"
}
run_test "click by ref succeeds" test_click_ref

test_click_nav() {
  local snap=$($BP open "$URL/" 2>&1)
  local ref=$(get_ref "$snap" "Go to Page 2")
  [[ -n "$ref" ]] || return 1
  local out=$($BP click "$ref" 2>&1)
  jok "$out" && jhas "$out" url "page2"
}
run_test "click link navigates to new page" test_click_nav

test_click_invalid() {
  $BP open "$URL/" 2>/dev/null
  $BP snapshot 2>/dev/null
  local out=$($BP click 999 2>&1)
  jnok "$out" && jhas "$out" hint "snapshot"
}
run_test "click invalid ref returns error with hint" test_click_invalid

echo ""
echo "── Type ──"

test_type_basic() {
  local snap=$($BP open "$URL/" 2>&1)
  local ref=$(get_ref "$snap" "Name")
  [[ -n "$ref" ]] || return 1
  local out=$($BP type "$ref" "hello" 2>&1)
  jok "$out"
}
run_test "type into textbox" test_type_basic

test_type_clear() {
  local snap=$($BP open "$URL/" 2>&1)
  local ref=$(get_ref "$snap" "Email")
  [[ -n "$ref" ]] || return 1
  local out=$($BP type "$ref" "new@test.com" --clear 2>&1)
  jok "$out"
  # Verify value was replaced
  local val=$($BP eval "document.getElementById('input2').value" 2>&1)
  jhas "$val" value "new@test.com"
}
run_test "type --clear replaces value" test_type_clear

test_type_submit() {
  local snap=$($BP open "$URL/" 2>&1)
  local ref=$(get_ref "$snap" "Search")
  [[ -n "$ref" ]] || return 1
  $BP type "$ref" "query" --submit 2>/dev/null
  local val=$($BP eval "document.getElementById('output').textContent" 2>&1)
  jhas "$val" value "submitted"
}
run_test "type --submit triggers form submit" test_type_submit

test_type_invalid() {
  $BP open "$URL/" 2>/dev/null; $BP snapshot 2>/dev/null
  local out=$($BP type 999 "hello" 2>&1)
  jnok "$out"
}
run_test "type invalid ref fails" test_type_invalid

echo ""
echo "── Press ──"

test_press_enter()   { $BP open "$URL/" 2>/dev/null; local out=$($BP press Enter 2>&1);   jok "$out"; }
test_press_escape()  { local out=$($BP press Escape 2>&1);  jok "$out"; }
test_press_combo()   { local out=$($BP press Control+a 2>&1); jok "$out"; }
test_press_tab()     { local out=$($BP press Tab 2>&1);     jok "$out"; }
test_press_arrow()   { local out=$($BP press ArrowDown 2>&1); jok "$out"; }
test_press_bad_mod() { local out=$($BP press FooMod+a 2>&1); jnok "$out"; }

run_test "press Enter" test_press_enter
run_test "press Escape" test_press_escape
run_test "press Control+a" test_press_combo
run_test "press Tab" test_press_tab
run_test "press ArrowDown" test_press_arrow
run_test "press unknown modifier fails" test_press_bad_mod

echo ""
echo "── Eval ──"

test_eval_title() {
  $BP open "$URL/" 2>/dev/null
  local out=$($BP eval "document.title" 2>&1)
  jok "$out" && jhas "$out" value "BP Test Page"
}
run_test "eval returns page title" test_eval_title

test_eval_number() {
  local out=$($BP eval "1 + 2" 2>&1)
  jhas "$out" value "3"
}
run_test "eval returns number" test_eval_number

test_eval_error() {
  local out=$($BP eval "throw new Error('boom')" 2>&1)
  jnok "$out"
}
run_test "eval error returns ok:false" test_eval_error

test_eval_stdin() {
  local out=$(echo 'document.title' | $BP eval 2>&1)
  jok "$out" && jhas "$out" value "BP Test Page"
}
run_test "eval from stdin" test_eval_stdin

test_eval_promise() {
  local out=$($BP eval "new Promise(r=>setTimeout(()=>r(42),100))" 2>&1)
  jhas "$out" value "42"
}
run_test "eval awaits promise" test_eval_promise

echo ""
echo "── Screenshot ──"

test_screenshot_file() {
  $BP open "$URL/" 2>/dev/null
  local out=$($BP screenshot /tmp/bp-test-ss.png 2>&1)
  jok "$out" && [[ -f /tmp/bp-test-ss.png ]] && [[ -s /tmp/bp-test-ss.png ]]
}
run_test "screenshot saves file" test_screenshot_file

test_screenshot_full() {
  local out=$($BP screenshot /tmp/bp-test-full.png --full 2>&1)
  jok "$out" && [[ -f /tmp/bp-test-full.png ]]
}
run_test "screenshot --full" test_screenshot_full

test_screenshot_selector() {
  local out=$($BP screenshot /tmp/bp-test-sel.png --selector "#btn1" 2>&1)
  jok "$out" && [[ -f /tmp/bp-test-sel.png ]]
}
run_test "screenshot --selector" test_screenshot_selector

test_screenshot_bad_selector() {
  local out=$($BP screenshot /tmp/bp-test-bad.png --selector "#nonexistent" 2>&1)
  jnok "$out"
}
run_test "screenshot bad selector fails" test_screenshot_bad_selector

echo ""
echo "── PDF ──"

test_pdf_file() {
  local out=$($BP pdf /tmp/bp-test.pdf 2>&1)
  jok "$out" && [[ -f /tmp/bp-test.pdf ]]
}
run_test "pdf saves file" test_pdf_file

test_pdf_landscape() {
  local out=$($BP pdf /tmp/bp-test-land.pdf --landscape 2>&1)
  jok "$out" && [[ -f /tmp/bp-test-land.pdf ]]
}
run_test "pdf --landscape" test_pdf_landscape

echo ""
echo "── Cookies ──"

test_cookies() {
  local out=$($BP cookies 2>&1)
  jok "$out"
}
run_test "cookies returns ok" test_cookies

echo ""
echo "── Frame ──"

test_frame_list() {
  $BP open "$URL/iframe-host" 2>/dev/null
  sleep 1
  local out=$($BP frame 2>&1)
  jok "$out" && [[ $(jlen "$out" frames) -ge 2 ]]
}
run_test "frame lists frames (host + iframe)" test_frame_list

test_frame_switch() {
  local out=$($BP frame 1 2>&1)
  jok "$out" && jhas "$out" frame "1"
}
run_test "frame switch to iframe" test_frame_switch

test_frame_eval() {
  local out=$($BP eval "document.querySelector('h1')?.textContent" 2>&1)
  jhas "$out" value "Inside Frame"
}
run_test "eval in iframe returns iframe content" test_frame_eval

test_frame_top() {
  $BP frame 0 2>/dev/null
  local out=$($BP eval "document.querySelector('h1')?.textContent" 2>&1)
  jhas "$out" value "Host"
}
run_test "frame 0 back to top" test_frame_top

test_frame_invalid() {
  local out=$($BP frame 99 2>&1)
  jnok "$out"
}
run_test "frame invalid index fails" test_frame_invalid

echo ""
echo "── Upload ──"

echo "test content" > /tmp/bp-test-upload.txt

test_upload_auto() {
  $BP open "$URL/upload" 2>/dev/null
  local out=$($BP upload /tmp/bp-test-upload.txt 2>&1)
  jok "$out"
}
run_test "upload auto-finds file input" test_upload_auto

test_upload_no_input() {
  $BP open "$URL/" 2>/dev/null
  local out=$($BP upload /tmp/bp-test-upload.txt 2>&1)
  jnok "$out"
}
run_test "upload fails when no file input" test_upload_no_input

test_upload_bad_file() {
  $BP open "$URL/upload" 2>/dev/null
  local out=$($BP upload /tmp/nonexistent-xyz.txt 2>&1)
  jnok "$out"
}
run_test "upload nonexistent file fails" test_upload_bad_file

test_upload_nth() {
  $BP open "$URL/upload" 2>/dev/null
  local out=$($BP upload /tmp/bp-test-upload.txt --nth 2 2>&1)
  jok "$out"
}
run_test "upload --nth 2 selects second input" test_upload_nth

echo ""
echo "── Auth ──"

test_auth_set() {
  local out=$($BP auth admin secret123 2>&1)
  jok "$out"
}
run_test "auth set credentials" test_auth_set

test_auth_clear() {
  local out=$($BP auth --clear 2>&1)
  jok "$out"
}
run_test "auth --clear" test_auth_clear

echo ""
echo "── Tabs ──"

test_tabs_single() {
  $BP close --all 2>/dev/null; $BP connect 2>/dev/null
  $BP open "$URL/" 2>/dev/null
  local out=$($BP tabs 2>&1)
  jok "$out" && [[ $(jlen "$out" tabs) -eq 1 ]]
}
run_test "tabs shows 1 tab" test_tabs_single

test_tab_switch() {
  $BP open "$URL/page2" --new 2>/dev/null
  local out=$($BP tab 0 2>&1)
  jok "$out" && jhas "$out" index "0"
}
run_test "tab switch" test_tab_switch

test_tab_invalid() {
  local out=$($BP tab 99 2>&1)
  jnok "$out"
}
run_test "tab invalid index fails" test_tab_invalid

test_close_tab() {
  local out=$($BP close 2>&1)
  jok "$out"
}
run_test "close tab" test_close_tab

echo ""
echo "── Dialog ──"

test_dialog_alert() {
  local out=$($BP open "$URL/dialog" 2>&1)
  jok "$out"
}
run_test "alert auto-dismissed (open doesn't hang)" test_dialog_alert

test_dialog_confirm() {
  local snap=$($BP open "$URL/confirm" 2>&1)
  local ref=$(get_ref "$snap" "Confirm")
  [[ -n "$ref" ]] || return 1
  $BP click "$ref" 2>/dev/null
  local val=$($BP eval "document.getElementById('r').textContent" 2>&1)
  jhas "$val" value "yes"
}
run_test "confirm auto-accepted" test_dialog_confirm

echo ""
echo "── Network ──"

test_net_list() {
  $BP net clear 2>/dev/null
  $BP open "$URL/" 2>/dev/null
  local out=$($BP net 2>&1)
  jok "$out" && [[ $(jlen "$out" requests) -gt 0 ]]
}
run_test "net lists requests after navigation" test_net_list

test_net_filter() {
  local out=$($BP net --url "*page2*" 2>&1)
  # May be empty but should succeed
  jok "$out"
}
run_test "net --url filter" test_net_filter

test_net_block() {
  local out=$($BP net block "*blocked*" 2>&1)
  jok "$out" && jhas "$out" "rule.type" "block"
}
run_test "net block creates rule" test_net_block

test_net_mock() {
  local out=$($BP net mock "*api/mock*" --body '{"m":true}' 2>&1)
  jok "$out" && jhas "$out" "rule.type" "mock"
}
run_test "net mock creates rule" test_net_mock

test_net_mock_works() {
  local out=$($BP eval "fetch('/api/mock').then(r=>r.json())" 2>&1)
  jok "$out" && jhas "$out" value "m"
}
run_test "net mock intercepts request" test_net_mock_works

test_net_headers() {
  local out=$($BP net headers "*" "X-Test:hello" 2>&1)
  jok "$out" && jhas "$out" "rule.type" "headers"
}
run_test "net headers creates rule" test_net_headers

test_net_rules() {
  local out=$($BP net rules 2>&1)
  jok "$out" && [[ $(jlen "$out" rules) -ge 3 ]]
}
run_test "net rules lists rules" test_net_rules

test_net_remove_all() {
  $BP net remove --all 2>/dev/null
  local out=$($BP net rules 2>&1)
  [[ $(jlen "$out" rules) -eq 0 ]]
}
run_test "net remove --all clears rules" test_net_remove_all

test_net_clear() {
  local out=$($BP net clear 2>&1)
  jok "$out"
}
run_test "net clear" test_net_clear

echo ""
echo "── Output Format ──"

test_json_default() {
  local out=$($BP eval "1" 2>&1)
  [[ "$out" == "{"* ]]
}
run_test "pipe mode outputs JSON" test_json_default

test_human_flag() {
  local out=$($BP --human snapshot 2>&1)
  [[ "$out" == *"[page]"* ]]
}
run_test "--human flag outputs human format" test_human_flag

test_error_hint() {
  $BP snapshot 2>/dev/null
  local out=$($BP click 999 2>&1)
  jnok "$out" && [[ "$out" == *"hint"* ]]
}
run_test "error includes hint field" test_error_hint

echo ""
echo "── Edge Cases ──"

test_limit_invalid() {
  local out=$($BP snapshot --limit abc 2>&1)
  jnok "$out"
}
run_test "--limit abc fails" test_limit_invalid

test_visual_overlay() {
  $BP open "$URL/" 2>/dev/null
  local out=$($BP eval "!!document.getElementById('__bp_overlay')" 2>&1)
  jhas "$out" value "true"
}
run_test "visual overlay injected" test_visual_overlay

# ═══════════════════════════════════════════════════
# SUMMARY
# ═══════════════════════════════════════════════════

echo ""
echo "═══════════════════════════════════"
if [[ $FAIL -eq 0 ]]; then
  printf "  \033[32m%d passed, 0 failed\033[0m\n" "$PASS"
else
  printf "  \033[32m%d passed\033[0m, \033[31m%d failed\033[0m\n" "$PASS" "$FAIL"
  echo -e "\nFailed:$ERRORS"
fi
echo "═══════════════════════════════════"
exit $FAIL
