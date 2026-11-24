#!/usr/bin/env bash
# 在已有开发环境中重跑 Beta 的会话图片、用量、设备接口和更新逻辑检查。
set -euo pipefail
# 多端收发可在隔离测试数据上单独回归。实机复验使用同一份源码生成的包。
if [[ ${1:-} == --handoff ]]; then
  cd -- "$(dirname -- "$0")/../apps/mobile"
  T3_MOBILE_TEST_PLATFORM=android ../../node_modules/.bin/vp test run \
    src/features/files/AndroidCaptureCoordinator.test.tsx \
    src/features/files/AutomaticFileHandoff.test.tsx \
    src/features/files/automatic-file-handoff.test.ts \
    src/features/files/androidCaptureBackground.test.ts \
    src/features/files/androidCapturePolicy.test.ts \
    src/features/settings/SettingsCrossDeviceRouteScreen.test.tsx \
    src/persistence/mobile-database.test.ts
  cd ../server
  ../../node_modules/.bin/vp test run \
    src/companion/http.test.ts src/companion/store.test.ts \
    src/fileExchange/FileHandoff.test.ts src/fileExchange/FileHandoffInbox.test.ts \
    src/mcp/toolkits/threadFileSave/handlers.test.ts src/mcp/toolkits/companion/handlers.test.ts
  exit
fi
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
