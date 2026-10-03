@echo off
rem Installs the v86 log agent (AGENT.CMD) into C:\v86 as a task that runs
rem at every start, before anyone signs in
mkdir C:\v86
mkdir C:\vm3dum_log
copy /y %~dp0RPCILOG.EXE C:\v86\
copy /y %~dp0AGENT.CMD C:\v86\
schtasks /create /f /tn v86agent /sc onstart /ru SYSTEM /tr C:\v86\AGENT.CMD > C:\v86\install.log 2>&1
