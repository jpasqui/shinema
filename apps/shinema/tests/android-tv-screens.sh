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
key KEYCODE_DPAD_RIGHT
key KEYCODE_DPAD_RIGHT
shot player-seek 2
key KEYCODE_BACK
shot back-to-detail 3
key KEYCODE_BACK
shot back-to-library 3
adb logcat -d -s ReactNativeJS:V >"$out/react-native.log" || true
