# Parse (never execute) a PowerShell script file and report syntax errors.
# Used to validate the generated dsh-restart helper without killing DSH.
param([Parameter(Mandatory = $true)][string]$Path)

$errors = $null
$text = Get-Content -Raw -LiteralPath $Path
$null = [System.Management.Automation.PSParser]::Tokenize($text, [ref]$errors)

if ($errors.Count -eq 0) {
  Write-Output 'PARSE OK (0 errors)'
  exit 0
}

foreach ($e in $errors) { Write-Output ("PARSE ERROR: " + $e.Message) }
exit 1
