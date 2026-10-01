@echo off
rem The v86 log agent: what Windows knows, sent to the host through the
rem VMware backdoor as RPCI log lines (tools/windows/rpcilog.c), for when the
rem guest's screen shows nothing. INSTALL.CMD makes it a startup task.
rem
rem It also sends the logs of VMware's user-mode 3D driver (written when
rem C:\vm3dum_log exists), and runs AGENT\EXTRA.CMD from a disc if there is
rem one, for diagnostics that change from run to run.
set D=C:\v86
if not exist C:\vm3dum_log mkdir C:\vm3dum_log
:loop
ping -n 91 127.0.0.1 >nul
tasklist > %D%\tasks.txt
wevtutil qe System /c:20 /rd:true /f:text > %D%\system.txt
wevtutil qe Application /c:12 /rd:true /f:text > %D%\application.txt
%D%\RPCILOG.EXE %D%\tasks.txt
%D%\RPCILOG.EXE %D%\system.txt
%D%\RPCILOG.EXE %D%\application.txt
for %%f in (C:\vm3dum_log\*.log) do %D%\RPCILOG.EXE %%f
for %%d in (d e f g h) do if exist %%d:\AGENT\EXTRA.CMD call %%d:\AGENT\EXTRA.CMD
goto loop
