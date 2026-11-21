!include "MUI2.nsh"
!ifndef APP_VERSION
  !define APP_VERSION "0.3.0"
!endif
Name "You Want Download ${APP_VERSION}"
OutFile "..\..\release\You-Want-Download-${APP_VERSION}-x64-Setup.exe"
InstallDir "$LOCALAPPDATA\Programs\You Want Download"
RequestExecutionLevel user
Unicode true
SetCompressor /SOLID lzma
BrandingText "You Want Download · Free and open source"
VIProductVersion "${APP_VERSION}.0"
VIAddVersionKey "ProductName" "You Want Download"
VIAddVersionKey "FileDescription" "You Want Download installer"
VIAddVersionKey "FileVersion" "${APP_VERSION}"
!define MUI_ICON "icon.ico"
!define MUI_UNICON "icon.ico"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
Section "Install"
  SetOutPath "$INSTDIR"
  File "..\bin\You-Want-Download.exe"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateDirectory "$SMPROGRAMS\You Want Download"
  CreateShortCut "$SMPROGRAMS\You Want Download\You Want Download.lnk" "$INSTDIR\You-Want-Download.exe"
  CreateShortCut "$SMPROGRAMS\You Want Download\Uninstall.lnk" "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\YouWantDownload" "DisplayName" "You Want Download"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\YouWantDownload" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\YouWantDownload" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\YouWantDownload" "InstallLocation" "$INSTDIR"
SectionEnd
Section "Uninstall"
  Delete "$INSTDIR\You-Want-Download.exe"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  Delete "$SMPROGRAMS\You Want Download\You Want Download.lnk"
  Delete "$SMPROGRAMS\You Want Download\Uninstall.lnk"
  RMDir "$SMPROGRAMS\You Want Download"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\YouWantDownload"
  ; User download files and settings are deliberately preserved.
SectionEnd
