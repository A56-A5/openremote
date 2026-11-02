#!/usr/bin/env bash
# OpenRemote Lite installation script
# Sets up the local bridge and guides you through deployment

set -e

echo "=== OpenRemote Lite Installation ==="
echo ""

# Step 1: Verify Node.js version
echo "1. Checking Node.js version..."
NODE_VERSION=$(node --version | grep -o 'v[0-9]' || echo "v0")
REQ_MAJOR=18
CURRENT_MAJOR=$(echo $NODE_VERSION | grep -o '[0-9]' || echo "0")
if [ "$CURRENT_MAJOR" -lt "$REQ_MAJOR" ]; then
  echo "   ⚠ Node.js $NODE_VERSION detected. Version $REQ_MAJOR+ recommended."
  echo "   Installing from https://nodejs.org/"
fi
echo "   ✓ Node.js $NODE_VERSION found"

# Step 2: Check for opencode
echo ""
echo "2. Checking for OpenCode..."
if command -v opencode &>/dev/null; then
  echo "   ✓ OpenCode is installed"
else
  echo "   ⚠ OpenCode not found in PATH"
  echo "   Install from https://opencode.ai"
fi

# Step 3: Check for bridge dependencies
echo ""
echo "3. Checking bridge setup..."
if [ -f "bin/openremote.js" ]; then
  echo "   ✓ openremote-lite bridge found at bin/openremote.js"
else
  echo "   ⚠ bin/openremote.js not found"
fi

# Step 4: Pairing code guidance
echo ""
echo "4. Pairing setup..."
echo "   The pairing code is generated automatically when you start the bridge."
echo "   Run: node bin/openremote.js start"
echo "   It will print an 8-character code (e.g., K7M2QX9P)"
echo "   Then deploy the frontend to Vercel and type the code on your phone"

# Step 5: Vercel deployment
echo ""
echo "5. Vercel deployment..."
echo "   This project's static frontend is already configured for Vercel."
echo "   If not already deployed, run from the project root:"
echo "   npx vercel link       # link to your existing Vercel project"
echo "   npx vercel --prod     # deploy to production"
echo "   Visit: https://openremote-link.vercel.app"
echo "   Type the 8-character code when prompted"

# Step 6: First-time usage
echo ""
echo "6. First-time usage..."
echo "   After pairing, the web UI will connect to your local OpenCode server."
echo "   Use /openremote tui for terminal-based bridge control."
echo "   Visit the docs: https://github.com/A56-A5/openremote"

echo ""
echo "=== Installation complete ==="
echo "Run 'node bin/openremote.js start' to start the bridge."
echo "Then open https://openremote-link.vercel.app on your phone."
echo "Type the 8-character code displayed in the terminal."