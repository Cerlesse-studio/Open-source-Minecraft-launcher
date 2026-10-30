!macro customInstall
  DetailPrint "放行 EasyTier 联机端口 (TCP/UDP 11010)"
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Cobble EasyTier TCP"'
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Cobble EasyTier UDP"'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="Cobble EasyTier TCP" dir=in action=allow protocol=TCP localport=11010 profile=any enable=yes'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="Cobble EasyTier UDP" dir=in action=allow protocol=UDP localport=11010 profile=any enable=yes'
!macroend
!macro customUnInstall
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Cobble EasyTier TCP"'
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Cobble EasyTier UDP"'
!macroend
