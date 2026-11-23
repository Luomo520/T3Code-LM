Unicode true
Name "T3Code-LM Windows 受控端"
OutFile "T3Code-LM-Companion-0.2.5-1-Windows-x64-Setup.exe"
InstallDir "$LOCALAPPDATA\Programs\T3Code-LM-Companion"
InstallDirRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\T3Code-LM-Companion" "InstallLocation"
RequestExecutionLevel user
SetCompressor /SOLID lzma

!include "MUI2.nsh"
!include "x64.nsh"

!define ARP "Software\Microsoft\Windows\CurrentVersion\Uninstall\T3Code-LM-Companion"
!define PRODUCT "T3Code-LM Windows 受控端"
!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"

VIProductVersion "0.2.5.1"
VIAddVersionKey /LANG=2052 "ProductName" "${PRODUCT}"
VIAddVersionKey /LANG=2052 "ProductVersion" "0.2.5-1"
VIAddVersionKey /LANG=2052 "FileVersion" "0.2.5.1"
VIAddVersionKey /LANG=2052 "FileDescription" "T3Code-LM Windows 受控端安装程序"
VIAddVersionKey /LANG=2052 "LegalCopyright" "T3Code-LM"

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_OK|MB_ICONSTOP "此安装包适用于 64 位 Windows。"
    Abort
  ${EndIf}
  SetShellVarContext current
FunctionEnd

Section "安装"
  SetOutPath "$INSTDIR"
  File "T3Code-LM-Companion.exe"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateShortcut "$SMPROGRAMS\T3Code-LM Windows 受控端.lnk" "$INSTDIR\T3Code-LM-Companion.exe"
  WriteRegStr HKCU "${ARP}" "DisplayName" "${PRODUCT}"
  WriteRegStr HKCU "${ARP}" "DisplayVersion" "0.2.5-1"
  WriteRegStr HKCU "${ARP}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${ARP}" "DisplayIcon" "$INSTDIR\T3Code-LM-Companion.exe"
  WriteRegStr HKCU "${ARP}" "UninstallString" '$\"$INSTDIR\Uninstall.exe$\"'
  WriteRegDWORD HKCU "${ARP}" "NoModify" 1
  WriteRegDWORD HKCU "${ARP}" "NoRepair" 1
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  ClearErrors
  Delete "$INSTDIR\T3Code-LM-Companion.exe"
  IfErrors 0 +3
    MessageBox MB_OK|MB_ICONSTOP "请先从 Windows 通知区域退出受控端，然后重新卸载。"
    Abort
  Delete "$SMPROGRAMS\T3Code-LM Windows 受控端.lnk"
  DeleteRegKey HKCU "${ARP}"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
SectionEnd
