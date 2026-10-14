; Celenne Studio installer additions (electron-builder includes build/installer.nsh in the NSIS script).

!include nsDialogs.nsh
!include FileFunc.nsh

; An install "just for me" runs without administrator rights, so it cannot add files to folders
; such as C:\Program Files. The folder page does not check this, and the copy would fail part-way
; ("Error opening file for writing"). This page appears only when the chosen folder cannot be
; written: it says why and keeps Next off, so the user goes Back and picks another folder (or
; installs for everyone, which asks Windows for administrator rights).
!macro customPageAfterChangeDir
  Page custom celenneFolderCheck

  Function celenneFolderCheck
    ${if} ${isUpdated}
      Abort
    ${endif}
    ; The nearest folder of the chosen path that already exists.
    StrCpy $R0 $INSTDIR
    ${Do}
      ${IfThen} ${FileExists} "$R0\*.*" ${|} ${ExitDo} ${|}
      ${GetParent} $R0 $R1
      ${IfThen} $R1 == "" ${|} ${ExitDo} ${|}
      StrCpy $R0 $R1
    ${Loop}
    ; Can this installer write there?
    ClearErrors
    FileOpen $R2 "$R0\celenne-setup-check.tmp" w
    ${IfNot} ${Errors}
      FileClose $R2
      Delete "$R0\celenne-setup-check.tmp"
      Abort ; yes: skip this page
    ${EndIf}
    !insertmacro MUI_HEADER_TEXT "Choose another folder" "This folder needs administrator rights."
    nsDialogs::Create 1018
    Pop $R3
    ${NSD_CreateLabel} 0 0 100% 100% "Celenne Studio can't be installed in:$\r$\n$\r$\n$INSTDIR$\r$\n$\r$\nYou chose to install it just for you, and only an administrator can add files to this folder.$\r$\n$\r$\nClick Back and choose a folder of your own (the suggested folder works), or go back to the first page and choose to install it for anyone who uses this computer."
    Pop $R3
    ; Next stays off on this page.
    GetDlgItem $R3 $HWNDPARENT 1
    EnableWindow $R3 0
    nsDialogs::Show
  FunctionEnd
!macroend
