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

# Step 3: Clean old builds
echo "Step 3: Cleaning old build files..."
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

# Step 4: Install dependencies
echo "Step 4: Installing project dependencies..."
echo "--------------------------------"
echo "This may take a few minutes..."
echo "Press Ctrl+C to cancel..."
echo
pnpm install
echo "Dependencies installed!"
echo

# Step 5: Build project
echo "Step 5: Building project..."
echo "--------------------------------"
echo "This may take a few minutes..."
echo "Press Ctrl+C to cancel..."
echo
pnpm build
echo "Project built!"
echo

# Step 6: Link to global
echo "Step 6: Linking to global npm..."
echo "--------------------------------"
pnpm link --global
echo "Global link successful!"
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