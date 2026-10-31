; 安装阶段的一次性放行。
;
; EasyTier 以无 TUN 模式运行，启动器本身不需要管理员权限；但房主要接受
; 好友的入站连接，Windows 防火墙必须放行内核的监听端口。安装器本来就以
; 管理员身份运行，所以在这里把规则写好，启动器运行时不再弹 UAC。

!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "放行 EasyTier 联机端口 (TCP/UDP 11010)"
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Cobble EasyTier TCP"'
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Cobble EasyTier UDP"'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="Cobble EasyTier TCP" dir=in action=allow protocol=TCP localport=11010 profile=any enable=yes'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="Cobble EasyTier UDP" dir=in action=allow protocol=UDP localport=11010 profile=any enable=yes'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DetailPrint "移除 EasyTier 防火墙规则"
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Cobble EasyTier TCP"'
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Cobble EasyTier UDP"'
!macroend
