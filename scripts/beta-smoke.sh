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
# 手机未接入时也可验证首页跨后端搜索，以及服务端的正文索引。
(
  cd ../mobile
  T3_MOBILE_TEST_PLATFORM=android ../../node_modules/.bin/vp test run \
    src/features/keyboard/paletteEnvironment.test.ts \
    src/features/keyboard/commandPaletteItems.test.ts \
    src/features/home/home-list-options.test.tsx
)
(cd ../../packages/client-runtime && ../../node_modules/.bin/vp test run src/state/threadSearch.test.ts)
(cd ../server && "$vp" test run src/orchestration-v2/ThreadSearch.test.ts)
