# Child of open-probe.ps1: opens one file in Photoshop with dialogs enabled and writes what it finds.
param([Parameter(Mandatory = $true)][string]$File, [Parameter(Mandatory = $true)][string]$Out)
$ErrorActionPreference = 'Stop'
$f = $File -replace '\\', '/'
$dir = $PSScriptRoot -replace '\\', '/'
$ps = New-Object -ComObject Photoshop.Application
$r = $ps.DoJavaScript("var FILE = '$f'; `$.evalFile(new File('$dir/open-probe.jsx'));")
Set-Content -Path $Out -Value $r -Encoding UTF8
