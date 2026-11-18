; Shared by the production wizard and the isolated NSIS test executable.
Var T3DetectedPath
Var T3DetectedScope
Var T3DetectedSource
Var T3DetectedRegView
Var T3ActiveView
Var T3Candidate

!macro T3ReadLocation OUT HIVE KEY
  !ifdef T3_DETECTION_TEST
    ReadINIStr ${OUT} "$EXEDIR\fixture.ini" "${HIVE}-$T3TestView" "${KEY}"
  !else
    ReadRegStr ${OUT} ${HIVE} "${KEY}" "InstallLocation"
  !endif
!macroend

!macro T3SetView VIEW
  SetRegView ${VIEW}
  StrCpy $T3ActiveView "${VIEW}"
  !ifdef T3_DETECTION_TEST
    StrCpy $T3TestView "${VIEW}"
  !endif
!macroend

!macro T3TryCandidate SCOPE SOURCE
  ${If} $T3DetectedPath == ""
  ${AndIf} $T3Candidate != ""
  ${AndIf} ${FileExists} "$T3Candidate\${APP_EXECUTABLE_FILENAME}"
  ${AndIf} ${FileExists} "$T3Candidate\resources\app.asar"
    GetFullPathName $T3DetectedPath "$T3Candidate"
    StrCpy $T3DetectedScope "${SCOPE}"
    StrCpy $T3DetectedRegView $T3ActiveView
    StrCpy $T3DetectedSource "${SOURCE}"
  ${EndIf}
!macroend

!macro T3TryRegistry HIVE SCOPE VIEW
  !insertmacro T3SetView ${VIEW}
  !insertmacro T3ReadLocation $T3Candidate ${HIVE} "Software\${APP_GUID}"
  !insertmacro T3TryCandidate "${SCOPE}" "${HIVE}-${VIEW}-install"
  !insertmacro T3ReadLocation $T3Candidate ${HIVE} "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_GUID}"
  !insertmacro T3TryCandidate "${SCOPE}" "${HIVE}-${VIEW}-uninstall"
!macroend

!macro T3DefineDetector
Function T3DetectInstall
  Push $R0
  StrCpy $T3DetectedPath ""
  StrCpy $T3DetectedScope "CurrentUser"
  StrCpy $T3DetectedRegView "64"
  StrCpy $T3DetectedSource "new-current-user"
  ; Current user's real installation wins over stale / other-scope records.
  !insertmacro T3TryRegistry HKCU "CurrentUser" 64
  !insertmacro T3TryRegistry HKCU "CurrentUser" 32
  !insertmacro T3SetView 64
  !ifdef T3_DETECTION_TEST
    ReadINIStr $T3Candidate "$EXEDIR\fixture.ini" "fallback" "current"
  !else
    StrCpy $T3Candidate "$LOCALAPPDATA\Programs\${APP_FILENAME}"
  !endif
  !insertmacro T3TryCandidate "CurrentUser" "current-default-directory"
  !insertmacro T3TryRegistry HKLM "all" 64
  !insertmacro T3TryRegistry HKLM "all" 32
  !insertmacro T3SetView 64
  !ifdef T3_DETECTION_TEST
    ReadINIStr $T3Candidate "$EXEDIR\fixture.ini" "fallback" "machine64"
  !else
    StrCpy $T3Candidate "$PROGRAMFILES64\${APP_FILENAME}"
  !endif
  !insertmacro T3TryCandidate "all" "machine64-default-directory"
  !insertmacro T3SetView 64
  !ifdef T3_DETECTION_TEST
    ReadINIStr $T3Candidate "$EXEDIR\fixture.ini" "fallback" "machine32"
  !else
    StrCpy $T3Candidate "$PROGRAMFILES32\${APP_FILENAME}"
  !endif
  !insertmacro T3TryCandidate "all" "machine32-default-directory"
  ${If} $T3DetectedRegView == "32"
    SetRegView 32
  ${Else}
    SetRegView 64
  ${EndIf}
  ${If} $T3DetectedPath == ""
    StrCpy $T3DetectedPath "$LOCALAPPDATA\Programs\${APP_FILENAME}"
  ${EndIf}
  StrCpy $INSTDIR $T3DetectedPath
  StrCpy $installMode $T3DetectedScope
  ${If} $T3DetectedScope == "CurrentUser"
    SetShellVarContext current
    StrCpy $hasPerUserInstallation "1"
    StrCpy $hasPerMachineInstallation "0"
  ${Else}
    SetShellVarContext all
    StrCpy $hasPerUserInstallation "0"
    StrCpy $hasPerMachineInstallation "1"
  ${EndIf}
  ; Preserve explicit /D=... overrides; the normal directory page stays editable.
  !insertmacro GetDParameter $R0
  ${If} $R0 != ""
    StrCpy $INSTDIR $R0
  ${EndIf}
  Pop $R0
FunctionEnd
!macroend
