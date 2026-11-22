# T3Code-LM Windows 受控端

本程序为 T3Code-LM 0.2.4-1 Beta 的独立 Windows x64 随包组件。配对后，T3Code-LM 服务可以向本机提交主屏幕截图、打开 T3Code-LM、打开记事本、正常关闭由受控端创建的窗口四种请求。Windows 用户在本机批准每个请求。主屏幕截图通过当前 Windows 用户的 Windows-MCP 回环端点生成并传回原服务。

## 使用

1. 在 Windows 10 或 11 x64 上运行安装程序，从开始菜单打开「T3Code-LM Windows 受控端」。应用使用当前 Windows 用户权限，需要 .NET Framework 4.8 或更新版本。
2. 从 T3Code-LM 的设备控制界面生成 Windows 配对码。输入服务根地址、设备名称和配对码。公网使用 HTTPS。位于受信任局域网的私有 IP 地址可以使用 HTTP，首次配对时会显示明文传输提示。
3. 选择「恢复接收」。关闭主窗口会收起到通知区域。暂停、退出或 Windows 锁定会停止接收操作。配对记录通过 Windows DPAPI 保存到当前用户的本地应用数据。
4. 若需截图，先在同一 Windows 登录会话中运行 Windows-MCP 4.1.7，其 HTTP 入口为 `127.0.0.1:8000/mcp`。用户接管时截图将提示失败。PNG 截图最长边最多 1440 像素，经服务返回。
5. 「开始录制」会让你选择本地 AVI 保存位置，录制主屏幕，无音频。通过窗口或通知区域的「停止录制」保存，也会在锁定 Windows 时停止。单段最多 10 分钟或 500 MB。「选择文件」供本机用户选取文件并查看选中的文件名。录制和文件选择留在本机。
6. 从受控端选择「解除配对」后退出，再从 Windows 的「已安装的应用」卸载。设备也可以在 T3Code-LM 的设备控制界面撤销。

## 构建

在 Windows PowerShell 中使用已有 NSIS 3.04 或兼容版本。

```powershell
.\build.ps1 -MakeNsis 'C:\Path\To\makensis.exe'
```

成品位于 `build/T3Code-LM-Companion-0.2.4-1-Windows-x64-Setup.exe`。WinForms 提供原生窗口与通知区域，.NET Framework 提供 HTTPS 和 DPAPI，Windows-MCP 提供截图，NSIS 提供按用户安装和卸载。安装程序采用应用版本 0.2.4-1，Windows 文件版本为 0.2.4.1。

`CompanionWindow.cs` 负责界面、配对和本机确认。 `Transport.cs` 负责服务器协议和配对记录。 `WindowsDesktop.cs` 负责受控窗口与 Windows-MCP。 `Recording.cs` 负责写入本机 MJPEG AVI。
