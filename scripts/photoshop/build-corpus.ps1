# Builds the Photoshop reference corpus with the locally installed Adobe Photoshop.
#   powershell -File scripts/photoshop/build-corpus.ps1 [-Out tests/fixtures/photoshop/corpus] [-Only blend-,mask-] [-Cases cases.jsx,cases-effects.jsx]
# Documents are generated from scratch (see cases.jsx); Photoshop's preferences are restored afterwards.
param(
  [string]$Out = (Join-Path $PSScriptRoot '..\..\tests\fixtures\photoshop\corpus'),
  [string]$Only = '',
  [string]$Cases = 'cases.jsx,cases-content.jsx'
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force $Out | Out-Null
$outAbs = (Resolve-Path $Out).Path -replace '\\', '/'
$dir = $PSScriptRoot -replace '\\', '/'
$ps = New-Object -ComObject Photoshop.Application
$includes = ($Cases.Split(',') | ForEach-Object { "`$.evalFile(new File('$dir/$_'));" }) -join ' '
$code = "var OUT = '$outAbs'; var ONLY = '$Only'; `$.evalFile(new File('$dir/lib.jsx')); $includes `$.evalFile(new File('$dir/run.jsx'));"
$ps.DoJavaScript($code)
