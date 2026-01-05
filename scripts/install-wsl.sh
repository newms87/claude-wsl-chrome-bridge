#!/bin/bash
# install-wsl.sh - Configure Claude Code to use the WSL relay for Chrome bridge
#
# Usage:
#   ./install-wsl.sh           # Install/configure
#   ./install-wsl.sh --help    # Show help
#
# This script configures Claude Code's MCP settings to use the WSL relay
# for communication with the Windows Chrome bridge.

set -e

# Get script directory and project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Configuration
RELAY_JS="$PROJECT_DIR/dist/wsl-relay.js"
CLAUDE_CONFIG_DIR="$HOME/.config/claude"
MCP_SETTINGS="$CLAUDE_CONFIG_DIR/mcp_settings.json"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

log() { echo -e "${CYAN}[*]${NC} $1"; }
success() { echo -e "${GREEN}[+]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[X]${NC} $1"; }

# Banner
echo ""
echo -e "${CYAN}============================================${NC}"
echo -e "${CYAN}  Claude WSL Chrome Bridge - WSL Setup${NC}"
echo -e "${CYAN}============================================${NC}"
echo ""

# Help
if [[ "$1" == "--help" || "$1" == "-h" ]]; then
    echo "Usage: $0 [options]"
    echo ""
    echo "Options:"
    echo "  --help, -h    Show this help message"
    echo ""
    echo "This script configures Claude Code to use the WSL relay"
    echo "for communication with the Windows Chrome bridge."
    echo ""
    echo "Prerequisites:"
    echo "  1. Run 'npm run build' in the project directory"
    echo "  2. Install the Windows side: ./scripts/install-windows.ps1"
    echo "  3. Start the Windows bridge: node dist/native-host.js"
    echo ""
    exit 0
fi

# Check if relay exists
if [[ ! -f "$RELAY_JS" ]]; then
    error "wsl-relay.js not found at: $RELAY_JS"
    error "Please run 'npm run build' first."
    echo ""
    echo -e "${YELLOW}Quick fix:${NC}"
    echo "  cd $PROJECT_DIR"
    echo "  npm install"
    echo "  npm run build"
    echo ""
    exit 1
fi

success "Found wsl-relay.js"
log "Relay path: $RELAY_JS"

# Check if Claude Code is installed
if ! command -v claude &> /dev/null; then
    warn "Claude Code CLI not found in PATH"
    warn "Make sure Claude Code is installed before using the bridge"
fi

# Create config directory if needed
if [[ ! -d "$CLAUDE_CONFIG_DIR" ]]; then
    mkdir -p "$CLAUDE_CONFIG_DIR"
    success "Created config directory: $CLAUDE_CONFIG_DIR"
fi

# MCP server configuration
MCP_SERVER_CONFIG=$(cat <<EOF
{
  "mcpServers": {
    "chrome-wsl-bridge": {
      "command": "node",
      "args": ["$RELAY_JS"],
      "env": {}
    }
  }
}
EOF
)

# Check for existing MCP settings
if [[ -f "$MCP_SETTINGS" ]]; then
    warn "Existing MCP settings found at: $MCP_SETTINGS"
    echo ""
    echo "Current contents:"
    echo -e "${YELLOW}$(cat "$MCP_SETTINGS")${NC}"
    echo ""

    # Check if chrome-wsl-bridge already configured
    if grep -q "chrome-wsl-bridge" "$MCP_SETTINGS" 2>/dev/null; then
        warn "chrome-wsl-bridge already configured in MCP settings"
        echo ""
        read -p "Do you want to update the configuration? (y/N) " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            log "No changes made"
            exit 0
        fi
    else
        echo "The chrome-wsl-bridge server needs to be added to your MCP settings."
        echo ""
        read -p "Do you want to add it now? (y/N) " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            log "No changes made"
            echo ""
            echo -e "${YELLOW}To manually add the bridge, add this to your mcp_settings.json:${NC}"
            echo ""
            echo "$MCP_SERVER_CONFIG" | python3 -c "import sys,json; d=json.load(sys.stdin); print(json.dumps(d['mcpServers']['chrome-wsl-bridge'], indent=2))"
            echo ""
            exit 0
        fi
    fi

    # Backup existing config
    BACKUP="$MCP_SETTINGS.backup.$(date +%Y%m%d_%H%M%S)"
    cp "$MCP_SETTINGS" "$BACKUP"
    success "Backed up existing config to: $BACKUP"

    # Merge configurations using Python (more reliable JSON handling)
    python3 << PYTHON_SCRIPT
import json
import sys

# Load existing config
with open("$MCP_SETTINGS", "r") as f:
    existing = json.load(f)

# New server config
new_server = {
    "command": "node",
    "args": ["$RELAY_JS"],
    "env": {}
}

# Ensure mcpServers exists
if "mcpServers" not in existing:
    existing["mcpServers"] = {}

# Add/update the chrome-wsl-bridge server
existing["mcpServers"]["chrome-wsl-bridge"] = new_server

# Write back
with open("$MCP_SETTINGS", "w") as f:
    json.dump(existing, f, indent=2)

print("Updated MCP settings successfully")
PYTHON_SCRIPT

    success "Updated MCP settings with chrome-wsl-bridge"
else
    # Create new MCP settings file
    echo "$MCP_SERVER_CONFIG" > "$MCP_SETTINGS"
    success "Created MCP settings: $MCP_SETTINGS"
fi

echo ""
echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN}  WSL Setup Complete!${NC}"
echo -e "${GREEN}============================================${NC}"
echo ""
echo -e "${YELLOW}Usage:${NC}"
echo ""
echo "1. First, start the Windows bridge (in Windows PowerShell):"
echo ""
echo -e "   ${CYAN}node dist/native-host.js${NC}"
echo ""
echo "   Or from the installed location:"
echo -e "   ${CYAN}node \$env:LOCALAPPDATA\\ClaudeWSLBridge\\native-host.js${NC}"
echo ""
echo "2. Then use Claude Code in WSL as normal:"
echo ""
echo -e "   ${CYAN}claude${NC}"
echo ""
echo "   Chrome tools should now work via the bridge!"
echo ""
echo -e "${YELLOW}Troubleshooting:${NC}"
echo ""
echo "- If connection fails, ensure the Windows bridge is running"
echo "- Check Windows Firewall isn't blocking localhost connections"
echo "- Try: export CLAUDE_BRIDGE_DEBUG=1 for verbose logging"
echo ""
