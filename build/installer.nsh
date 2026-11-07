; Lists Tern with Windows as a browser that can open web links, for this Windows account.
; Windows only lets the person using the PC choose the default, so this never sets it.
!macro customInstall
  !define TERN_CAPS "Software\Clients\StartMenuInternet\${PRODUCT_NAME}"
  !define TERN_PROGID "Software\Classes\${PRODUCT_NAME}URL"
  !define TERN_EXE "$INSTDIR\${APP_EXECUTABLE_FILENAME}"

  WriteRegStr HKCU "${TERN_PROGID}" "" "${PRODUCT_NAME} web address"
  WriteRegStr HKCU "${TERN_PROGID}\DefaultIcon" "" "${TERN_EXE},0"
  WriteRegStr HKCU "${TERN_PROGID}\shell\open\command" "" '"${TERN_EXE}" "%1"'

  WriteRegStr HKCU "${TERN_CAPS}" "" "${PRODUCT_NAME}"
  WriteRegStr HKCU "${TERN_CAPS}\DefaultIcon" "" "${TERN_EXE},0"
  WriteRegStr HKCU "${TERN_CAPS}\shell\open\command" "" '"${TERN_EXE}"'
  WriteRegStr HKCU "${TERN_CAPS}\Capabilities" "ApplicationName" "${PRODUCT_NAME}"
  WriteRegStr HKCU "${TERN_CAPS}\Capabilities" "ApplicationDescription" "A light browser with built-in ad blocking and no AI features."
  WriteRegStr HKCU "${TERN_CAPS}\Capabilities" "ApplicationIcon" "${TERN_EXE},0"
  WriteRegStr HKCU "${TERN_CAPS}\Capabilities\StartMenu" "StartMenuInternet" "${PRODUCT_NAME}"
  WriteRegStr HKCU "${TERN_CAPS}\Capabilities\URLAssociations" "http" "${PRODUCT_NAME}URL"
  WriteRegStr HKCU "${TERN_CAPS}\Capabilities\URLAssociations" "https" "${PRODUCT_NAME}URL"
  WriteRegStr HKCU "Software\RegisteredApplications" "${PRODUCT_NAME}" "${TERN_CAPS}\Capabilities"

  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'

  !undef TERN_CAPS
  !undef TERN_PROGID
  !undef TERN_EXE
!macroend

; An update removes the old version first, and that mustn't lose the browser's place.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\RegisteredApplications" "${PRODUCT_NAME}"
    DeleteRegKey HKCU "Software\Clients\StartMenuInternet\${PRODUCT_NAME}"
    DeleteRegKey HKCU "Software\Classes\${PRODUCT_NAME}URL"
    System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  ${endIf}
!macroend
