# 版本更新记录

## 0.2.6

从 0.2.6 起，T3Code-LM 已移除从上游 T3 Code 继承的产品遥测。服务端不再向 T3 或 PostHog 上报产品使用事件，也不再为统计读取 Codex 或 Claude 的登录文件。Windows、网页和 Android 客户端不再为遥测发送跨设备关联标识。Android 也已移除自动崩溃上报。

Token 用量、缓存率和生成速度仍可在自己的 T3 环境中查看。如果你主动开启远程任务通知，通知中继会收到项目名、会话名和任务状态。如果你配置了 OTLP 诊断导出，诊断数据会发往你指定的地址。

[查看本版下载与其他变化](https://github.com/Luomo520/T3Code-LM/releases/tag/v0.2.6-1)
