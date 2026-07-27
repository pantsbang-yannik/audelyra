#!/usr/bin/env bash
# Audelyra 功耗采样——powermetrics 需要 sudo，无法从应用内调起，故为半自动。
#
# 用法：sudo bash scripts/perf-power.sh [秒数]
# 对齐方式：先在应用 #perf 面板点「跑功耗场景」，再立刻跑本脚本；两侧靠时间戳对齐。
#
# 口径：powermetrics 自述其数字为 SoC 子系统的「估算」功耗，不含背光等整机项。
# 输出与引用一律称「SoC 估算功耗」，不得称「整机功耗」。
set -euo pipefail

DURATION="${1:-60}"
INTERVAL_MS=1000
SAMPLES=$(( DURATION * 1000 / INTERVAL_MS ))
RAW="$(mktemp -t audelyra-power)"
trap 'rm -f "$RAW"' EXIT

if [[ "$(id -u)" -ne 0 ]]; then
  echo "需要 sudo：sudo bash scripts/perf-power.sh ${DURATION}" >&2
  exit 1
fi

STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# 采样器逐个探测：M 系新芯片上部分采样器可能不可用，
# 不可用时降级为可用子集并明确报出哪项没测到——绝不静默省略。
AVAILABLE=()
UNAVAILABLE=()
for s in cpu_power gpu_power ane_power thermal battery tasks; do
  if powermetrics --samplers "$s" -i 200 -n 1 >/dev/null 2>&1; then
    AVAILABLE+=("$s")
  else
    UNAVAILABLE+=("$s")
  fi
done

if [[ ${#AVAILABLE[@]} -eq 0 ]]; then
  echo "没有任何 powermetrics 采样器可用，无法采集" >&2
  exit 1
fi

SAMPLER_LIST="$(IFS=,; echo "${AVAILABLE[*]}")"
echo "采样器：${SAMPLER_LIST}（${DURATION}s，每 ${INTERVAL_MS}ms 一点）" >&2
if [[ ${#UNAVAILABLE[@]} -gt 0 ]]; then
  echo "不可用：${UNAVAILABLE[*]}" >&2
fi

powermetrics --samplers "$SAMPLER_LIST" --show-process-gpu \
  -i "$INTERVAL_MS" -n "$SAMPLES" > "$RAW" 2>/dev/null

ENDED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# 解析：字段名随 macOS 版本漂移，取不到的项输出 null 而不是 0
awk -v started="$STARTED_AT" -v ended="$ENDED_AT" -v dur="$DURATION" \
    -v avail="$SAMPLER_LIST" -v unavail="${UNAVAILABLE[*]:-}" '
function emit(name, sum, cnt) {
  printf "    \"%s\": %s", name, (cnt > 0 ? sprintf("%.2f", sum / cnt) : "null")
}
/CPU Power/       { c_sum += $(NF-1); c_n++ }
/GPU Power/       { g_sum += $(NF-1); g_n++ }
/ANE Power/       { a_sum += $(NF-1); a_n++ }
/Combined Power/  { t_sum += $(NF-1); t_n++ }
/audelyra-tap/    { tap_n++ }
END {
  print "{"
  printf "  \"startedAt\": \"%s\",\n", started
  printf "  \"endedAt\": \"%s\",\n", ended
  printf "  \"durationSec\": %s,\n", dur
  printf "  \"samplers\": \"%s\",\n", avail
  printf "  \"unavailableSamplers\": \"%s\",\n", unavail
  print  "  \"note\": \"数字为 SoC 子系统估算功耗（mW），不含背光等整机项\","
  print  "  \"avgMilliwatts\": {"
  emit("cpu", c_sum, c_n); print ","
  emit("gpu", g_sum, g_n); print ","
  emit("ane", a_sum, a_n); print ","
  emit("combined", t_sum, t_n); print ""
  print  "  },"
  printf "  \"tapProcessSampleHits\": %d\n", tap_n
  print "}"
}
' "$RAW"
