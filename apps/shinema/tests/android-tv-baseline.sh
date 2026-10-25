#!/usr/bin/env bash
# One-off PR evidence: captures the previous TV app (main at 94dcac1, built
# for x86) as the "before" for the rebuild, then uninstalls it so the new
# app's checks start clean. The old app accepts HTTPS servers only, so its
# first screen is shown.
#   tests/android-tv-baseline.sh <unsigned-apk> <output-dir>
set -euo pipefail
unsigned="$1"
out="$2"
mkdir -p "$out"
tools=$(ls -d "$ANDROID_HOME"/build-tools/* | sort -V | tail -1)
work=$(mktemp -d)

# Signed with a throwaway key only so the emulator accepts it.
keytool -genkeypair -keystore "$work/baseline.jks" -storepass baseline \
  -keypass baseline -alias baseline -keyalg RSA -keysize 2048 -validity 1 \
  -dname "CN=Shinema baseline" >/dev/null 2>&1
"$tools/zipalign" -f 4 "$unsigned" "$work/aligned.apk"
"$tools/apksigner" sign --ks "$work/baseline.jks" --ks-pass pass:baseline \
  --key-pass pass:baseline --out "$work/baseline.apk" "$work/aligned.apk"

# Always remove it, so a failed capture cannot affect the new app's checks.
trap 'adb uninstall io.shinema.tv >/dev/null 2>&1 || true' EXIT
adb install "$work/baseline.apk"
adb shell screenrecord --size 1280x720 --bit-rate 4000000 /sdcard/before.mp4 &
recorder=$!
adb shell am start -W -n io.shinema.tv/.MainActivity
sleep 15
adb exec-out screencap -p >"$out/before-first-screen.png"
adb shell input keyevent KEYCODE_DPAD_DOWN
sleep 2
adb shell input keyevent KEYCODE_DPAD_DOWN
sleep 3
adb exec-out screencap -p >"$out/before-focus.png"
adb shell pkill -INT screenrecord || true
wait "$recorder" || true
sleep 2
adb pull /sdcard/before.mp4 "$out/before.mp4" || true
