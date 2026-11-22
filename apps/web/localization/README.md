# PC 选择性汉化层

复用 `markshan00/t3code-zh` 的 MIT 授权 AST 插件、运行时和词库（本地参考版本 `0.1.1-zh.2`）。来源：https://github.com/markshan00/t3code-zh 。原始许可证保存在本目录 `LICENSE`。

`vite.config.ts` 在生产构建和开发预览启用此插件；测试模式不改写英文源码。安装构建依赖：在此目录执行 `npm ci --ignore-scripts`，然后按主工程正常构建。依赖锁定在本目录，不改变上游 pnpm 依赖树。

只转换 AST 明确的界面显示位置，保留协议值、比较、类型、动态用户内容、代码、路径、命令、产品/模型名及短统计标签。词库未命中的文字原样显示；保守匹配不会扫描或修改页面 DOM。

默认简体中文。设置中的界面语言通过 ClientSettings 保存。还没有 ClientSettings 或已有网页设置缺少语言字段时，沿用旧的 `t3code-zh.locale` 偏好。应用保存语言后，选择性汉化层会在简体中文和英文之间同步切换。涉及模块加载时就已求值的界面文案时，页面刷新一次。其他语言的 GT 词条由各自目录提供。旧 `window.__t3zh.setLocale` 调用也交给界面设置保存。

PC 顶栏的 Balance、Token usage、Cache hit rate、Tokens per second 等完整英文标题也以精确恒等词条保护；限定词 last 5 requests / last request 随完整标题保留英文。其他菜单仍按旧包范围汉化。

`plugin/index.mjs` 是构建工具的 JS 入口，声明文件仅描述 Vite 插件接口，避免把第三方 AST 工具纳入应用 composite 类型项目；其后仍使用原始 TypeScript 插件。单测：`npm test`。
