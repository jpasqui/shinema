#!/usr/bin/env bash
# Measures the v1 performance budgets on a connected Android TV device (or
# emulator) over adb, with the app already paired to a server that has a
# library. Prints a JSON report and exits 1 if a budget is missed.
#
#   tests/tv-budgets.sh [output.json]
#
# Budgets (see the plan): cold start to a usable screen under 3 s, under 5%
# janky frames while scrolling the grid, 95th-percentile frame time under
# 33 ms, and memory that stays roughly flat after repeated browsing.
# Emulator numbers are not representative; use the reference Google TV stick.
set -euo pipefail
out="${1:-tv-budgets.json}"
pkg=io.shinema.tv

key() { adb shell input keyevent "$1"; }
pss_kb() {
  adb shell dumpsys meminfo "$pkg" | awk '/TOTAL PSS:/ {print $3; exit} /^ *TOTAL / {print $2; exit}'
}

adb shell am force-stop "$pkg"
start_ms=$(adb shell am start -W -n "$pkg/.MainActivity" | awk -F': ' '/TotalTime/ {print $2}' | tr -d '\r')
sleep 6

# Scroll down and back through the grid with the D-pad.
adb shell dumpsys gfxinfo "$pkg" reset >/dev/null
for _ in $(seq 1 3); do
  for _ in $(seq 1 12); do key KEYCODE_DPAD_DOWN; done
  for _ in $(seq 1 12); do key KEYCODE_DPAD_UP; done
done
stats=$(adb shell dumpsys gfxinfo "$pkg")
frames=$(echo "$stats" | awk -F': ' '/Total frames rendered/ {print $2; exit}' | tr -d '\r')
janky=$(echo "$stats" | awk -F'[:(%]' '/Janky frames:/ {gsub(/ /,"",$3); print $3; exit}' | tr -d '\r')
p95=$(echo "$stats" | awk -F': ' '/95th percentile/ {gsub(/ms/,"",$2); print $2; exit}' | tr -d '\r')

# Memory before and after ten more passes.
before=$(pss_kb)
for _ in $(seq 1 10); do
  for _ in $(seq 1 12); do key KEYCODE_DPAD_DOWN; done
  for _ in $(seq 1 12); do key KEYCODE_DPAD_UP; done
done
sleep 3
after=$(pss_kb)

node -e '
const [start, frames, janky, p95, before, after, out] = process.argv.slice(1);
const n = (v) => (v === "" || v === undefined ? null : Number(v));
const report = {
  device: process.env.ANDROID_SERIAL ?? "default",
  coldStartMs: n(start),
  framesRendered: n(frames),
  jankyPercent: n(janky),
  frameP95Ms: n(p95),
  memoryKb: { before: n(before), after: n(after) },
};
const checks = {
  coldStart: report.coldStartMs !== null && report.coldStartMs < 3000,
  jank: report.jankyPercent !== null && report.jankyPercent < 5,
  frameTime: report.frameP95Ms !== null && report.frameP95Ms < 33,
  memoryFlat:
    report.memoryKb.before !== null &&
    report.memoryKb.after !== null &&
    report.memoryKb.after <= report.memoryKb.before * 1.15,
};
report.checks = checks;
report.pass = Object.values(checks).every(Boolean);
require("fs").writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
process.exit(report.pass ? 0 : 1);
' "$start_ms" "$frames" "$janky" "$p95" "$before" "$after" "$out"
