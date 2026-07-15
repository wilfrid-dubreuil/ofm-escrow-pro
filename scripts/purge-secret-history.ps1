param(
  [string]$RepoPath = "c:\ofm-escrow-pro",
  [string]$RemoteUrl = "https://github.com/wilfrid-dubreuil/ofm-escrow-pro.git",
  [string]$SecretPath = "backend/midgen-u6gv0i-firebase-adminsdk-fbsvc-ae88ed43bb.json",
  [string]$MirrorPath = "$env:TEMP\ofm-escrow-pro-history-purge.git"
)

$ErrorActionPreference = "Stop"

Write-Host "[1/6] Verification pre-requis"
py -3 --version | Out-Null

if (Test-Path $MirrorPath) {
  Remove-Item -Recurse -Force $MirrorPath
}

Write-Host "[2/6] Clone miroir"
git clone --mirror $RepoPath $MirrorPath | Out-Null

Push-Location $MirrorPath
try {
  Write-Host "[3/6] Purge historique avec git-filter-repo"
  py -3 -m git_filter_repo --path $SecretPath --invert-paths --force | Out-Null

  Write-Host "[4/6] Verification de purge"
  $historyMatches = git log --all --name-only --pretty=format: | Select-String -SimpleMatch $SecretPath
  if ($historyMatches) {
    throw "Echec: le secret est encore present dans l'historique."
  }

  $objectMatches = git rev-list --objects --all | Select-String -SimpleMatch $SecretPath
  if ($objectMatches) {
    throw "Echec: l'objet secret est encore present dans la base Git."
  }

  Write-Host "[5/6] Preflight force-push mirror"
  git remote add origin $RemoteUrl
  git push --force --mirror --dry-run origin

  Write-Host "[6/6] Pret a publier"
  Write-Host "Commande de publication reelle:"
  Write-Host "  git -C $MirrorPath push --force --mirror origin"
}
finally {
  Pop-Location
}
