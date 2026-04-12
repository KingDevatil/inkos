#!/bin/bash

# InkOS Build and Install Script (Bash Version)

clear
echo "InkOS Build and Install Script"
echo "==============================="
echo

# Step 1: Check Node.js
echo "Step 1: Checking Node.js version..."
echo "--------------------------------"
node -v
echo "Node.js version check completed!"
echo

# Step 2: Check pnpm
echo "Step 2: Checking pnpm version..."
echo "--------------------------------"
pnpm -v
echo "pnpm version check completed!"
echo

# Step 3: Check global link status
echo "Step 3: Checking global link status..."
echo "--------------------------------"
globalPackages=$(pnpm list -g 2>/dev/null)
inkosLinked=$(echo "$globalPackages" | grep "@actalk/inkos")
wrongInkosLinked=$(echo "$globalPackages" | grep "^inkos ")

if [ -n "$wrongInkosLinked" ]; then
    echo "Found incorrect 'inkos' global link, removing..."
    pnpm remove -g inkos
    echo "Incorrect link removed!"
fi

if [ -n "$inkosLinked" ]; then
    echo "@actalk/inkos is already linked globally."
    echo "Current link:"
    pnpm list -g | grep "@actalk/inkos"
else
    echo "@actalk/inkos is not linked globally yet."
fi
echo

# Step 4: Clean old builds
echo "Step 4: Cleaning old build files..."
echo "--------------------------------"
if [ -d "packages/cli/dist" ]; then
    echo "Removing packages/cli/dist..."
    rm -rf "packages/cli/dist"
fi
if [ -d "packages/core/dist" ]; then
    echo "Removing packages/core/dist..."
    rm -rf "packages/core/dist"
fi
if [ -d "packages/studio/dist" ]; then
    echo "Removing packages/studio/dist..."
    rm -rf "packages/studio/dist"
fi
echo "Old builds cleaned!"
echo

# Step 5: Install dependencies
echo "Step 5: Installing project dependencies..."
echo "--------------------------------"
echo "This may take a few minutes..."
echo "Press Ctrl+C to cancel..."
echo
pnpm install
echo "Dependencies installed!"
echo

# Step 6: Build project
echo "Step 6: Building project..."
echo "--------------------------------"
echo "This may take a few minutes..."
echo "Press Ctrl+C to cancel..."
echo
pnpm build
echo "Project built!"
echo

# Step 7: Link to global
echo "Step 7: Linking CLI to global..."
echo "--------------------------------"

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI_PATH="$SCRIPT_DIR/packages/cli"

# Check if already linked
linkedPath=$(pnpm list -g 2>/dev/null | grep "@actalk/inkos.*link:")
if [ -n "$linkedPath" ]; then
    echo "Unlinking existing global link..."
    (cd "$CLI_PATH" && pnpm unlink --global 2>/dev/null)
fi

echo "Linking @actalk/inkos to global..."
cd "$CLI_PATH" && pnpm link --global
echo "Global link successful!"
cd "$SCRIPT_DIR"
echo

# Step 8: Verify global link
echo "Step 8: Verifying global link..."
echo "--------------------------------"
if command -v inkos &> /dev/null; then
    version=$(inkos --version 2>/dev/null)
    if [ -n "$version" ]; then
        echo "✓ inkos command is available globally!"
        echo "  Version: $version"
    else
        echo "✗ inkos command found but failed to get version"
        echo "  Please restart your terminal or run: source ~/.bashrc"
    fi
else
    echo "✗ inkos command not found in PATH"
    echo "  Please restart your terminal or run: source ~/.bashrc"
fi
echo

echo
echo "===================================="
echo "Build and install completed successfully!"
echo "===================================="
echo "You can now use 'inkos' command in any directory"
echo
echo "Example commands:"
echo "  inkos --help          - Show help"
echo "  inkos book create     - Create a new book"
echo "  inkos studio          - Start InkOS Studio"
echo "  inkos write next      - Write next chapter"
echo
echo "Press any key to exit..."
read -n 1 -s
