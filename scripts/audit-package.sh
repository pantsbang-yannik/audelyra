#!/bin/bash
# 包内容审计（发布前必跑门禁）：防泄漏 + 捆绑完整性 + 签名 + 调试剥离 + 公证装订五关
set -e
cd "$(dirname "$0")/.."
APP="dist/mac-arm64/Audelyra.app"
[ -d "$APP" ] || { echo "先 npm run dist"; exit 1; }
ASAR="$APP/Contents/Resources/app.asar"
LIST="$(npx --yes @electron/asar list "$ASAR")"

echo "== ① 防泄漏：asar 内不得出现开发内容 =="
LEAKS=$(echo "$LIST" | grep -iE "docs/|tests/|CLAUDE\.md|shapes-src|scripts/|native/|\.map$|^/node_modules" || true)
[ -z "$LEAKS" ] && echo "OK 无泄漏" || { echo "泄漏内容："; echo "$LEAKS"; exit 1; }

echo "== ② 捆绑完整性：Resources 必备文件 =="
# 形状清单与 assets/shapes/ 同步（statue 已退役删除，2026-07-22）
for f in audelyra-tap media-control/bin/media-control media-control/lib/media-control/mediaremote-adapter.pl \
         media-control/Frameworks/MediaRemoteAdapter.framework \
         assets/shapes/heart.bin assets/shapes/demo-gramophone.bin assets/shapes/demo-cassette.bin \
         assets/shapes/demo-headphones.bin assets/shapes/demo-mic.bin \
         assets/licenses/media-control.txt; do
  [ -e "$APP/Contents/Resources/$f" ] && echo "OK $f" || { echo "缺 $f"; exit 1; }
done

echo "== ③ 签名：Developer ID + hardened runtime，附带二进制一个不漏 =="
codesign --verify --deep --strict "$APP" && echo "OK 整包签名完整"
SIGN_INFO=$(codesign -dvv "$APP" 2>&1)
echo "$SIGN_INFO" | grep -q "TeamIdentifier=AHRB2HD27M" && echo "OK TeamIdentifier=AHRB2HD27M" \
  || { echo "非正式签名（adhoc 或缺证书）："; echo "$SIGN_INFO" | grep -E "Signature|TeamIdentifier"; exit 1; }
echo "$SIGN_INFO" | grep -Eq "flags=.*runtime" && echo "OK hardened runtime" || { echo "缺 hardened runtime"; exit 1; }
# extraResources 里的 Mach-O 由 electron-builder.yml 的 mac.binaries 显式签名，逐一复核（漏签公证即被拒）
for b in audelyra-tap media-control/Frameworks/MediaRemoteAdapter.framework \
         media-control/lib/media-control/MediaRemoteAdapterTestClient; do
  codesign --verify --strict "$APP/Contents/Resources/$b" 2>/dev/null \
    && codesign -dvv "$APP/Contents/Resources/$b" 2>&1 | grep -q "TeamIdentifier=AHRB2HD27M" \
    && echo "OK 已签 $b" || { echo "漏签 $b"; exit 1; }
done

echo "== ④ 调试剥离：生产包不得含 debug/trace chunk =="
DBG=$(echo "$LIST" | grep -iE "^/out/.*debug|^/out/.*trace-controls" || true)
[ -z "$DBG" ] && echo "OK 已剥离" || { echo "含调试产物："; echo "$DBG"; exit 1; }

echo "== ⑤ 公证装订：Gatekeeper 放行 =="
xcrun stapler validate "$APP" >/dev/null 2>&1 && echo "OK 公证票据已装订" || { echo "未装订公证票据"; exit 1; }
SPCTL=$(spctl --assess --type execute -vv "$APP" 2>&1)
echo "$SPCTL" | grep -q "Notarized Developer ID" && echo "OK Gatekeeper: Notarized Developer ID" \
  || { echo "Gatekeeper 评估未通过："; echo "$SPCTL"; exit 1; }

echo "✅ 审计通过"
