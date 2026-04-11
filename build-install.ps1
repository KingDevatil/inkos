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

# Step 3: Clean old builds
Write-Host "Step 3: Cleaning old build files..."
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

# Step 4: Install dependencies
Write-Host "Step 4: Installing project dependencies..."
Write-Host "--------------------------------"
Write-Host "This may take a few minutes..."
Write-Host "Press Ctrl+C to cancel..."
Write-Host
pnpm install
Write-Host "Dependencies installed!"
Write-Host

# Step 5: Build project
Write-Host "Step 5: Building project..."
Write-Host "--------------------------------"
Write-Host "This may take a few minutes..."
Write-Host "Press Ctrl+C to cancel..."
Write-Host
pnpm build
Write-Host "Project built!"
Write-Host

# Step 6: Link to global
Write-Host "Step 6: Linking to global npm..."
Write-Host "--------------------------------"
pnpm link --global
Write-Host "Global link successful!"
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
