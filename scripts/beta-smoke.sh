#!/usr/bin/env bash
# 在已有开发环境中重跑 Beta 的会话图片、用量、设备接口和更新逻辑检查。
set -euo pipefail
cd -- "$(dirname -- "$0")/../apps/web"
if [[ -z ${PLAYWRIGHT_BROWSERS_PATH:-} && -d /vol1/1000/DATA/software/playwright-browsers ]]; then
  export PLAYWRIGHT_BROWSERS_PATH=/vol1/1000/DATA/software/playwright-browsers
fi
vp=./node_modules/.bin/vp
"$vp" test run --project unit \
  src/components/chat/ExpandedImagePreview.test.ts \
  src/components/device/deviceHubApi.test.ts \
  src/components/settings/updateTrackSwitch.logic.test.ts \
  src/components/sidebar/updateEverything.logic.test.ts \
  src/lib/contextWindow.test.ts
"$vp" test run --project browser src/components/chat/ExpandedImageDialog.browser.test.tsx
