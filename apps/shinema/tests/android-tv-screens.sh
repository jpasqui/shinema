#!/usr/bin/env bash
# Drives the Android TV build in an emulator with D-pad key events against
# the mock server (reached from the emulator as 10.0.2.2) and saves
# screenshots of each screen, for side-by-side review with the web ones.
#   tests/android-tv-screens.sh <apk> <output-dir>
set -euo pipefail
apk="$1"
out="$2"
mkdir -p "$out"

shot() {
  sleep "${2:-2}"
  adb exec-out screencap -p >"$out/$1.png"
}
key() { adb shell input keyevent "$1"; }

adb install -r "$apk"
adb shell am start -W -n io.shinema.tv/.MainActivity
shot connect 15
# The address field has focus on the first screen.
adb shell input text "10.0.2.2:8790"
key KEYCODE_ENTER
shot library 10
key KEYCODE_DPAD_RIGHT
shot library-focus 2
key KEYCODE_DPAD_CENTER
shot detail 4
key KEYCODE_DPAD_CENTER
shot player 8
adb shell dumpsys window | grep -E "mCurrentFocus|mFocusedApp" >"$out/focus-in-player.txt" || true
key KEYCODE_DPAD_RIGHT
key KEYCODE_DPAD_RIGHT
shot player-seek 2
key KEYCODE_BACK
shot back-to-detail 3
key KEYCODE_BACK
shot back-to-library 3
adb logcat -d -s ReactNativeJS:V >"$out/react-native.log" || true
adb logcat -d >"$out/logcat.txt" || true

# Behaviour checks, so a regression fails the job instead of hiding in a
# screenshot.
fail=0
if ! adb shell dumpsys activity activities | grep -q "ResumedActivity.*io.shinema.tv"; then
  echo "FAIL: the app is no longer in the foreground after Back"
  fail=1
fi
if grep -q " E ReactNativeJS" "$out/react-native.log"; then
  echo "FAIL: JavaScript errors in the log"
  grep " E ReactNativeJS" "$out/react-native.log" | head -5
  fail=1
fi
# The second title was played from about 8 s and moved 20 s forward with
# two Right presses; leaving the player saved that position to the server.
id=$(node -e 'console.log(require("crypto").createHash("sha256").update("movies/Northern Lines.mkv").digest("hex"))')
position=$(curl -fsS "http://127.0.0.1:8790/api/media/$id/progress" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)?.positionSeconds ?? 0))')
echo "Saved position after seeking: ${position}s"
if ! node -e "process.exit(Number('$position') >= 20 ? 0 : 1)"; then
  echo "FAIL: D-pad seeking did not move playback (saved ${position}s, expected at least 20s)"
  fail=1
fi
exit "$fail"
