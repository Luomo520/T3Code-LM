!ifndef BUILD_UNINSTALLER
  !include "${PROJECT_DIR}\apps\desktop\resources\detect-install.nsh"
!endif

; Keep edits compatible with electron-builder 26.16.1's installer and uninstaller.
; A live T3 session must be closed by its user, never killed by the installer.
!macro assertNoPortableData ROOT
  ${If} ${FileExists} "${ROOT}\userdata\."
  ${OrIf} ${FileExists} "${ROOT}\data\."
  ${OrIf} ${FileExists} "${ROOT}\.t3\."
    ${IfNot} ${Silent}
      MessageBox MB_ICONEXCLAMATION|MB_OK "程序目录内存在便携数据。请先备份并移出 userdata、data 或 .t3 文件夹，再重试。"
    ${EndIf}
    SetErrorLevel 3
    Quit
  ${EndIf}
!macroend

!macro customCheckAppRunning
  !insertmacro assertNoPortableData "$INSTDIR"
  ReadRegStr $R2 HKCU "Software\${APP_GUID}" "InstallLocation"
  ${If} $R2 != ""
    !insertmacro assertNoPortableData "$R2"
  ${EndIf}
  nsProcess::_FindProcess "${APP_EXECUTABLE_FILENAME}"
  Pop $R0
  ${If} $R0 == 0
    ${IfNot} ${Silent}
      MessageBox MB_ICONEXCLAMATION|MB_OK "请先正常退出 T3 Code，再重新运行安装或卸载程序。当前会话不会被安装程序强制结束。"
    ${EndIf}
    SetErrorLevel 2
    Quit
  ${EndIf}
!macroend

; Apply the discovered location before the directory page and skip the scope page.
!macro customHeader
  !ifndef BUILD_UNINSTALLER
    !insertmacro T3DefineDetector
  !endif
!macroend

!macro customInit
  Call T3DetectInstall
!macroend

!macro customInstallMode
  !ifndef BUILD_UNINSTALLER
  Call T3DetectInstall
  ${If} $T3DetectedScope == "all"
    ${IfNot} ${UAC_IsAdmin}
      !insertmacro UAC_RunElevated
      Quit
    ${EndIf}
  ${EndIf}
  Abort
  !endif
!macroend

; Keep an existing nonstandard folder intact; retain the upstream guard for new paths.
!macro customPageAfterChangeDir
  !undef MUI_PAGE_CUSTOMFUNCTION_PRE
  !define MUI_PAGE_CUSTOMFUNCTION_PRE T3InstFilesPre
  Function T3InstFilesPre
    ${If} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    ${AndIf} ${FileExists} "$INSTDIR\resources\app.asar"
      Return
    ${EndIf}
    Call instFilesPre
  FunctionEnd
!macroend

!macro customInstall
  !ifndef DO_NOT_CREATE_START_MENU_SHORTCUT
    ${IfNot} ${FileExists} "$newStartMenuLink"
      !insertmacro createMenuDirectory
      CreateShortCut "$newStartMenuLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
      ClearErrors
      WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
    ${EndIf}
  !endif
!macroend
