# InkOS Build and Install Script (PowerShell Version)

Clear-Host
Write-Host "InkOS Build and Install Script"
Write-Host "==============================="
Write-Host

# Step 1: Check Node.js
Write-Host "Step 1: Checking Node.js version..."
Write-Host "--------------------------------"
node -v
Write-Host "Node.js version check completed!"
Write-Host

# Step 2: Check pnpm
Write-Host "Step 2: Checking pnpm version..."
Write-Host "--------------------------------"
pnpm -v
Write-Host "pnpm version check completed!"
Write-Host

# Step 3: Check global link status
Write-Host "Step 3: Checking global link status..."
Write-Host "--------------------------------"
$globalPackages = pnpm list -g 2>$null
$inkosLinked = $globalPackages | Select-String "@actalk/inkos"
$wrongInkosLinked = $globalPackages | Select-String "^inkos "

if ($wrongInkosLinked) {
    Write-Host "Found incorrect 'inkos' global link, removing..."
    pnpm remove -g inkos
    Write-Host "Incorrect link removed!"
}

if ($inkosLinked) {
    Write-Host "@actalk/inkos is already linked globally."
    Write-Host "Current link:"
    pnpm list -g | Select-String "@actalk/inkos"
} else {
    Write-Host "@actalk/inkos is not linked globally yet."
}
Write-Host

# Step 4: Clean old builds
Write-Host "Step 4: Cleaning old build files..."
Write-Host "--------------------------------"
if (Test-Path "packages\cli\dist") {
    Write-Host "Removing packages\cli\dist..."
    Remove-Item -Recurse -Force "packages\cli\dist"
}
if (Test-Path "packages\core\dist") {
    Write-Host "Removing packages\core\dist..."
    Remove-Item -Recurse -Force "packages\core\dist"
}
if (Test-Path "packages\studio\dist") {
    Write-Host "Removing packages\studio\dist..."
    Remove-Item -Recurse -Force "packages\studio\dist"
}
Write-Host "Old builds cleaned!"
Write-Host

# Step 5: Install dependencies
Write-Host "Step 5: Installing project dependencies..."
Write-Host "--------------------------------"
Write-Host "This may take a few minutes..."
Write-Host "Press Ctrl+C to cancel..."
Write-Host
pnpm install
Write-Host "Dependencies installed!"
Write-Host

# Step 6: Build project
Write-Host "Step 6: Building project..."
Write-Host "--------------------------------"
Write-Host "This may take a few minutes..."
Write-Host "Press Ctrl+C to cancel..."
Write-Host
pnpm build
Write-Host "Project built!"
Write-Host

# Step 7: Link to global
Write-Host "Step 7: Linking CLI to global..."
Write-Host "--------------------------------"

# First unlink if already linked to avoid conflicts
$cliPath = Join-Path $PSScriptRoot "packages\cli"
Push-Location $cliPath

try {
    # Check if already linked
    $linkedPath = pnpm list -g 2>$null | Select-String "@actalk/inkos.*link:"
    if ($linkedPath) {
        Write-Host "Unlinking existing global link..."
        pnpm unlink --global 2>$null
    }

    Write-Host "Linking @actalk/inkos to global..."
    pnpm link --global
    Write-Host "Global link successful!"
} finally {
    Pop-Location
}
Write-Host

# Step 8: Verify global link
Write-Host "Step 8: Verifying global link..."
Write-Host "--------------------------------"
try {
    $version = inkos --version 2>$null
    if ($version) {
        Write-Host "✓ inkos command is available globally!"
        Write-Host "  Version: $version"
    } else {
        Write-Host "✗ inkos command not found in PATH"
        Write-Host "  Please restart your terminal or run: refreshenv"
    }
} catch {
    Write-Host "✗ inkos command not found in PATH"
    Write-Host "  Please restart your terminal or run: refreshenv"
}
Write-Host

Write-Host
Write-Host "===================================="
Write-Host "Build and install completed successfully!"
Write-Host "===================================="
Write-Host "You can now use 'inkos' command in any directory"
Write-Host
Write-Host "Example commands:"
Write-Host "  inkos --help          - Show help"
Write-Host "  inkos book create     - Create a new book"
Write-Host "  inkos studio          - Start InkOS Studio"
Write-Host "  inkos write next      - Write next chapter"
Write-Host
Write-Host "Press any key to exit..."
Read-Host
