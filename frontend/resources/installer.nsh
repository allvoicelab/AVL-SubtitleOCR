!macro customInstall
  # Keep the installer choice beside the application. The app copies it into
  # userData on first launch, so elevated/per-machine installs and upgrades do
  # not depend on which Windows profile ran the installer.
  CreateDirectory "$INSTDIR\resources"
  ClearErrors
  FileOpen $0 "$INSTDIR\resources\installer-default-language.json" w
  ${IfNot} ${Errors}
    ${If} $LANGUAGE == 2052
      FileWrite $0 '{"language":"zh-CN","installerLanguageId":"'
    ${Else}
      FileWrite $0 '{"language":"en","installerLanguageId":"'
    ${EndIf}
    FileWrite $0 "$LANGUAGE"
    FileWrite $0 '"}'
    FileClose $0
  ${EndIf}
!macroend
