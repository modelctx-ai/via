@echo off
rem via.cmd: forwards "via ..." typed on the Windows side to the via installed inside a WSL2 distribution.
rem
rem   wsl.exe -e via <the same arguments>
rem
rem Not part of the npm package (package.json "files" lists only dist/). Copy it to a folder on the
rem Windows PATH. Set VIA_WSL_DISTRO (a distribution name without spaces, as listed by "wsl -l -q")
rem to use another distribution than the default one.
rem
rem NOT VERIFIED ON A REAL WINDOWS MACHINE. Known limits and the list of things still to measure:
rem docs/guides/getting-started.md, section "Windows", "via.cmd shim".
rem
rem wsl.exe passes its arguments on unchanged, but cmd.exe has already parsed this line: & | < > ^ and
rem %VAR% in an argument are cmd.exe's business first. Prefer --args @file over inline JSON.
setlocal
set "VIA_WSL_TARGET="
if defined VIA_WSL_DISTRO set "VIA_WSL_TARGET=-d %VIA_WSL_DISTRO%"
wsl.exe %VIA_WSL_TARGET% -e via %*
exit /b %ERRORLEVEL%
