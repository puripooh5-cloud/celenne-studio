# Photoshop converts copies of the text layers of every PSD in -In to shape layers (its own layout)
# and saves the results to -Out (see outline.jsx).
#   powershell -ExecutionPolicy Bypass -File scripts/photoshop/outline.ps1 -In <folder> -Out <folder>
param([Parameter(Mandatory = $true)][string]$In, [Parameter(Mandatory = $true)][string]$Out)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force $Out | Out-Null
$inAbs = (Resolve-Path $In).Path -replace '\\', '/'
$outAbs = (Resolve-Path $Out).Path -replace '\\', '/'
$dir = $PSScriptRoot -replace '\\', '/'
$ps = New-Object -ComObject Photoshop.Application
$ps.DoJavaScript("var IN = '$inAbs'; var OUT = '$outAbs'; `$.evalFile(new File('$dir/outline.jsx'));")
