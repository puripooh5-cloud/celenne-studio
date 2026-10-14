# Lets the locally installed Photoshop open every PSD in -In and re-save it to -Out.
#   powershell -ExecutionPolicy Bypass -File scripts/photoshop/resave.ps1 -In <folder> -Out <folder>
param([Parameter(Mandatory = $true)][string]$In, [Parameter(Mandatory = $true)][string]$Out)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force $Out | Out-Null
$inAbs = (Resolve-Path $In).Path -replace '\\', '/'
$outAbs = (Resolve-Path $Out).Path -replace '\\', '/'
$dir = $PSScriptRoot -replace '\\', '/'
$ps = New-Object -ComObject Photoshop.Application
$ps.DoJavaScript("var IN = '$inAbs'; var OUT = '$outAbs'; `$.evalFile(new File('$dir/resave.jsx'));")
