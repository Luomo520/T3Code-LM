# 原生搜索通过容器类名排除代码块语言标题，发布构建需保留该类名。
-keepnames class com.swmansion.enriched.markdown.segments.CodeBlockContainerView

# Shizuku/Sui 在独立进程中通过类名加载安装服务。
-keep class expo.modules.t3nativecontrols.T3ApkInstallService { public <init>(); }
