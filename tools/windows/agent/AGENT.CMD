@echo off
rem The v86 log agent: what Windows knows, sent to the host through the
rem VMware backdoor as RPCI log lines (tools/windows/rpcilog.c), for when the
rem guest's screen shows nothing. INSTALL.CMD makes it a startup task.
set D=C:\v86
:loop
ping -n 91 127.0.0.1 >nul
tasklist > %D%\tasks.txt
wevtutil qe System /c:20 /rd:true /f:text > %D%\system.txt
wevtutil qe Application /c:12 /rd:true /f:text > %D%\application.txt
%D%\RPCILOG.EXE %D%\tasks.txt
%D%\RPCILOG.EXE %D%\system.txt
%D%\RPCILOG.EXE %D%\application.txt
goto loop
