# T3Code-LM

**在电脑、手机和浏览器中使用 AI 编程助手，随时查看任务、用量和余额。**

T3Code-LM 是基于 [T3 Code](https://github.com/pingdotgg/t3code) 的中文增强版，主要为个人日常使用而维护。它把 Codex、Claude Code 等 AI 编程工具放进同一个界面：在电脑上开始开发，离开电脑后，也能用手机查看回复、继续沟通和确认操作。

你可以直接在 Windows 电脑上使用，也可以让 Linux 电脑或 NAS 运行服务，再从其他设备连接。适合需要在多台设备之间继续 App、网页、桌面应用或硬件开发工作的用户。

**[下载 T3Code-LM](https://github.com/Luomo520/T3Code-LM/releases/latest)** · [查看全部版本](https://github.com/Luomo520/T3Code-LM/releases) · [反馈问题](https://github.com/Luomo520/T3Code-LM/issues)

## 这个版本增加了什么？

### 余额与用量，一眼看清

- 在顶部查看已支持供应商的余额、Token 用量、缓存率和生成速度，减少切换到供应商网站查询的次数。
- 用 **Day** 查看当天从 0 点开始的 Token 用量，更容易掌握今天用了多少。
- 点击顶部统计展开详情，查看最近 5 次请求的 **Token、缓存率和速度**，方便比较不同模型的使用表现。
- 余额等信息取决于供应商是否支持查询，以及你的配置；没有对应数据时不会凭空生成数值。

### 三端连接，按自己的设备习惯使用

- **Windows**：安装后即可使用桌面界面和本地服务，也能连接 NAS 或其他电脑上的服务。
- **Android**：在手机上查看项目、继续会话和处理确认操作；连接同一服务后，可以看到同一份项目和会话。
- **浏览器**：打开运行中的服务所提供的网页即可使用，方便临时换一台电脑操作。

### 文件看不了，也能直接下载

- 遇到 EXE、APK 等不能直接预览的文件，可以查看文件信息、**复制路径或下载到当前设备**。
- Windows 可使用应用内下载；已安装 IDM 时，也可交给 IDM 处理。
- Android 文件默认保存到 **`Download/T3Code/`**，交给系统下载后，切到后台仍可继续。
- 大文件暂时仅支持局域网下载；点击下载后才开始准备任务。

### 模型选择和日常操作更顺手

- 中文界面，常用模型可以收藏；搜索需要时再展开，减少手机屏幕占用。
- 用滑条调整支持该选项的模型的思考强度，保留 Low、Medium、High 等英文档位，便于辨认。
- 优化余额详情、模型弹窗和窄屏布局；手机底部导航与部分操作区域使用半透明效果，并适配深浅主题。
- Windows 顶部增加可拖动区域，小窗口下也更容易移动窗口。

### 项目、会话与任务状态更好查找

- 按项目、最近会话或 Status 查看工作，也可以切换全部项目和当前项目范围。
- 优化历史会话展示与继续加载，方便找回之前的工作。
- 改进删除后的同步、重连后的列表更新和手机导航恢复，减少重复操作。

### 更新和重启，由你决定

- 在应用中检查本仓库发布的更新，自己决定什么时候安装；客户端和服务端可以分别更新。
- Windows 提供**完整安装器和便携版**，安装器会尝试识别已有安装目录。
- Android 下载 APK 后由系统确认安装；使用移动网络下载前会先提醒。
- 支持从已连接的客户端请求重启受支持的服务端，Linux 服务端也支持通过客户端发起更新，减少远程手动操作。
- 客户端与服务端版本不同只会提醒，不会仅因版本号不同阻止使用。

## 从哪里下载？

进入 **[本仓库 Releases](https://github.com/Luomo520/T3Code-LM/releases/latest)**，按设备选择文件：

- **Windows 日常安装或升级**：选择文件名以 `windows-x64-installer.exe` 结尾的完整安装器。
- **Windows 便携使用**：选择以 `windows-x64-portable.zip` 结尾的压缩包。
- **Android 手机**：选择以 `android-arm64-apk.apk` 结尾的安装包。
- **Linux 电脑或 NAS**：选择以 `linux-x64-server.tar.gz` 结尾的服务端包，其中包含配套网页。

各端可能单独发布更新，请以下载文件的版本和该页说明为准。

## 如何开始使用？

1. 在准备运行 AI 工具的 Windows 或 Linux 设备上启动 T3Code-LM，并完成所用 AI 工具的账号或 API 配置。
2. 添加你的项目文件夹，选择模型，创建会话开始工作。
3. 需要手机或其他电脑接着使用时，从对应客户端连接这台设备上的服务。

T3Code-LM 不提供模型额度，使用你自己的 AI 工具、订阅或供应商配置。余额查询、思考强度、服务端重启等功能是否可用，取决于所连接的工具、供应商和服务环境。

## 关于原项目

本项目基于 MIT 许可的 [T3 Code](https://github.com/pingdotgg/t3code) 修改，保留原项目的许可证及相关说明。下方保留上游英文介绍；其中的官网、应用商店和原仓库下载入口对应原版 T3 Code。**使用本修改版，请从上方的 T3Code-LM 下载入口获取安装包。**

<details>
<summary>展开原版 T3 Code 介绍与文档（英文）</summary>

<p align="center">
  <a href="https://t3.codes">
    <img src="./assets/prod/t3-black-web-icon-192x192.png" width="80" height="80" alt="T3 Code logo" />
  </a>
</p>

<h1 align="center">T3 Code</h1>

<p align="center">The open-source control plane for coding agents.</p>

<p align="center">
  <a href="https://t3.codes/download"><strong>Download</strong></a> ·
  <a href="https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824">iOS</a> ·
  <a href="https://play.google.com/store/apps/details?id=com.t3tools.t3code">Android</a> ·
  <a href="https://app.t3.codes">Web</a> ·
  <a href="./docs/README.md">Docs</a> ·
  <a href="https://discord.gg/jn4EGJjrvv">Discord</a>
</p>

<p align="center">
  <a href="https://t3.codes">
    <img src="./.github/readme/hero.webp" width="100%" alt="T3 Code on desktop with a finished Claude thread, next to the phone app asking to approve a command from Codex" />
  </a>
</p>

T3 Code runs the coding agents on your machine and gives them one fast interface. Start a thread at your desk, then approve the next step from your phone.

It works with Claude Code, Codex, Cursor, OpenCode, Grok Build, Antigravity, Kiro, Pi, Muse Code, fx, and any [ACP](./docs/user/providers-acp.md) agent. If an agent is set up on your computer, T3 Code can control it.

## What you get

- **Your subscriptions.** T3 Code does not resell tokens. It drives the agents you are already signed in to.
- **Every agent in one place.** Change models in the middle of a thread. Let Claude hand a task to Codex.
- **Desktop, web, and phone.** One server, and every client shows the same threads. There are apps for iOS and Android.
- **Remote ready.** Run agents on any machine. Connect over your local network, Tailscale, or [T3 Connect](./docs/user/remote-access.md).
- **Git built in.** Each thread can work in its own worktree. Review the diff, then commit, push, and open a pull request with one button.
- **Fast.** Performance is a feature here. We measure it, and we treat a dropped frame as a bug.
- **Open.** MIT licensed. If you don't like something, fork it.

## Install

### Desktop app

[Download T3 Code](https://t3.codes/download) for macOS, Windows, or Linux. You can also use a package manager:

| Platform       | Command                                                              |
| -------------- | -------------------------------------------------------------------- |
| macOS          | `brew install --cask t3-code`                                        |
| Windows        | `winget install T3Tools.T3Code` or `scoop install extras/t3code`     |
| Arch Linux     | `yay -S t3code-bin`                                                  |
| Nix            | `nix profile add github:NixOS/nixpkgs/nixos-unstable#t3code`         |
| Debian, Ubuntu | `.deb` from [Releases](https://github.com/pingdotgg/t3code/releases) |

### Command line

This installs the `t3` command. Run `t3` to start the server and open the web app.

```bash
curl -fsSL https://t3.codes/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://t3.codes/install.ps1 | iex
```

To try it once without an install, run `npx t3@latest`.

### Phone

Get the app from the [App Store](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824) or [Google Play](https://play.google.com/store/apps/details?id=com.t3tools.t3code). Then follow [remote access](./docs/user/remote-access.md) to connect it to your computer.

### Sign in to an agent

T3 Code needs one agent that is installed and signed in. For example, install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`, or install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`.

[Provider setup](./docs/user/install.md#providers) has the steps for each agent. [Install T3 Code](./docs/user/install.md) covers nightly builds, AppImage, WSL, and NixOS.

## "Wait, what are you selling me?"

Nothing. We built T3 Code because we wanted the best possible development experience with agents. We were inspired by existing solutions like the Codex desktop app, Conductor, Claude Desktop and Cursor Glass, but none met our bar.

We wanted something performant, remote-ready, and truly open. If we ever go the wrong direction, we want you to have everything you need to fork and build the tool that you want.

## Documentation

- [Install and first run](./docs/user/install.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Source control](./docs/user/source-control.md)
- [Connect outside agents over MCP](./docs/user/outside-agents.md)
- [FAQ](./docs/user/faq.md)

[All docs](./docs/README.md) has the full list.

## Contributing

We have limited review capacity. Small, focused fixes are the most likely to be merged. Features need an approved discussion first.

- Read [CONTRIBUTING.md](./CONTRIBUTING.md) before you report a bug or open a pull request.
- Put feature requests in [Ideas](https://github.com/pingdotgg/t3code/discussions/categories/ideas).
- Build from source with the [development runbook](./docs/operations/development.md#first-checkout). The [architecture overview](./docs/internals/overview.md) explains how it works.
- Get help in [Discord](https://discord.gg/jn4EGJjrvv).

## License

[MIT](./LICENSE)

</details>
