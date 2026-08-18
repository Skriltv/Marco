Write-Host "Starting repo structure fix..."

if (Test-Path "README.md") {
    Rename-Item -Path "README.md" -NewName "APP_README.md"
    Write-Host "Renamed misplaced app README.md -> APP_README.md"
}

if (Test-Path "Marco\README.md") {
    Move-Item -Path "Marco\README.md" -Destination "README.md"
    Write-Host "Moved outer README.md back to repo root"
}

$appItems = @(
    "index.html",
    "package.json",
    "package-lock.json",
    "pnpm-lock.yaml",
    "tsconfig.json",
    "vite.config.ts",
    "installer",
    "public",
    "scripts",
    "src",
    "src-tauri",
    "macros",
    "APP_README.md"
)

foreach ($item in $appItems) {
    if (Test-Path $item) {
        Move-Item -Path $item -Destination "Marco\" -Force
        Write-Host "Moved $item into Marco\"
    }
}

if (Test-Path "Marco\APP_README.md") {
    Rename-Item -Path "Marco\APP_README.md" -NewName "README.md"
    Write-Host "Renamed Marco\APP_README.md -> Marco\README.md"
}

Write-Host ""
Write-Host "===== DONE ====="
Write-Host ""
Write-Host "Repo root now contains:"
Get-ChildItem

Write-Host ""
Write-Host "Marco folder now contains:"
Get-ChildItem Marco
