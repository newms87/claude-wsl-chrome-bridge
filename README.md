# Claude WSL Chrome Bridge

Enable Claude Code running in WSL to use Chrome browser integration on Windows.

## Prerequisites

Before installing this bridge, you need:

### 1. Claude Code in WSL

Install Claude Code in your WSL environment:
```bash
npm install -g @anthropic-ai/claude-code
```

### 2. Enable Chrome Integration in Claude Code

Run Claude Code once and enable Chrome integration. This creates the native host script that the bridge needs:
```bash
claude
```

Then in Claude, type `/chrome` or enable it via settings. Verify it worked:
```bash
ls ~/.claude/chrome/chrome-native-host
```

### 3. Claude Chrome Extension

Install the **official** Claude browser extension in Chrome:
- Visit https://claude.ai/chrome
- Or search "Claude" in the Chrome Web Store

> **Note**: The bridge is configured for the official Claude extension ID (`fcoeoabgfenejglbffodgkkbkcdhcgfn`). This ID is fixed for all Chrome Web Store installs. Unpacked/developer extensions will have different IDs and won't work.

## The Problem

Claude Code's Chrome integration doesn't work natively in WSL because:
1. Chrome runs on Windows, not in WSL
2. Chrome's Native Messaging only communicates with Windows processes
3. Claude Code in WSL can't directly receive messages from Chrome

## The Solution

This bridge creates a relay between Chrome on Windows and Claude Code in WSL:

```
Chrome Extension <-> Windows Native Host <-> TCP:9333 <-> WSL Relay <-> Claude Code
```

## Installation

### Quick Install (Recommended)

Run this in **PowerShell** (Administrator recommended for firewall rule):

```powershell
irm "https://raw.githubusercontent.com/newms87/claude-wsl-chrome-bridge/master/dist/install.ps1" -OutFile install.ps1
.\install.ps1
```

This installs:
- **Windows**: Native host in `%LOCALAPPDATA%\ClaudeWSLBridge\`
- **WSL**: Relay and `claude-chrome` command in `~/.local/bin/`
- **Firewall**: Inbound rule for port 9333 (requires admin)

> **Note**: If not running as admin, the firewall rule may fail. You can add it manually or run the installer again as admin.

### After Installation

1. **Restart Chrome** completely (close all windows)
2. In WSL, run: `claude-chrome`

## Usage

Instead of running `claude` directly, use the wrapper command:

```bash
claude-chrome
```

This starts the relay and launches Claude Code with Chrome integration enabled.

### Passing Arguments

All arguments are forwarded to Claude Code:

```bash
claude-chrome --model opus
claude-chrome --resume
```

## How It Works

### Components

| Component | Location | Purpose |
|-----------|----------|---------|
| **native-host.js** | Windows `%LOCALAPPDATA%\ClaudeWSLBridge\` | Receives messages from Chrome, forwards to WSL |
| **wsl-relay.js** | WSL `~/.local/lib/claude-chrome-bridge/` | Connects to Windows, spawns Claude's native host |
| **claude-chrome** | WSL `~/.local/bin/` | Wrapper script that starts the relay |

### Message Flow

1. Chrome extension sends message via Native Messaging
2. Windows `native-host.js` receives it, forwards over TCP:9333
3. WSL `wsl-relay.js` receives it, forwards to Claude's `chrome-native-host`
4. Claude Code processes the request
5. Response flows back through the same path

## Troubleshooting

### Check Logs

**WSL relay log:**
```bash
cat /tmp/claude-wsl-relay.log
```

**Windows native host log:**
```powershell
Get-Content "$env:LOCALAPPDATA\ClaudeWSLBridge\native-host.log" -Tail 50
```

### Common Issues

#### "Extension not connected"

1. Make sure Chrome is running
2. Click the Claude extension icon in Chrome toolbar
3. Check that the extension is installed from https://claude.ai/chrome

#### "Connection timeout" in WSL log

The Windows native host isn't running. Try:

1. Restart Chrome completely
2. Click the Claude extension icon
3. Check Windows Firewall allows port 9333:
   ```powershell
   Get-NetFirewallRule -DisplayName "Claude WSL Chrome Bridge"
   ```

#### Firewall rule missing

If the installer couldn't create the firewall rule (requires admin), add it manually:

```powershell
# Run as Administrator
New-NetFirewallRule -DisplayName "Claude WSL Chrome Bridge" -Direction Inbound -Protocol TCP -LocalPort 9333 -Action Allow -Profile Private
```

#### Manual Windows native host test

```powershell
node "$env:LOCALAPPDATA\ClaudeWSLBridge\native-host.js"
```

Should print startup messages and listen on port 9333.

### Uninstall

```powershell
.\install.ps1 -Uninstall
```

Or with force (if files are locked):

```powershell
.\install.ps1 -Uninstall -Force
```

## Development

### Prerequisites

- Node.js 18+
- npm

### Build

```bash
npm install
npm run build
```

### Build Installer

```bash
npm run release
```

This generates `dist/install.ps1` with embedded JS files.

### Project Structure

```
src/
├── native-host.ts      # Windows: Chrome <-> TCP bridge
├── wsl-relay.ts        # WSL: TCP <-> Claude bridge
├── protocol.ts         # Chrome Native Messaging protocol
└── shared/
    ├── logger.ts       # Logging utilities
    ├── lifecycle.ts    # Graceful shutdown handling
    ├── constants.ts    # Shared constants
    └── index.ts        # Barrel exports

scripts/
├── build-installer.js  # Generates self-contained installer
└── claude-chrome.sh    # Development wrapper script

dist/
├── install.ps1         # Self-contained installer
├── native-host.js      # Built Windows component
└── wsl-relay.js        # Built WSL component
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDE_BRIDGE_PORT` | 9333 | TCP port for Windows-WSL communication |
| `CLAUDE_BRIDGE_HOST` | auto-detected | Windows host IP (usually WSL gateway) |
| `CLAUDE_BRIDGE_DEBUG` | 0 | Set to 1 for verbose logging |
| `CLAUDE_NATIVE_HOST` | auto-detected | Path to Claude's chrome-native-host |

## License

MIT
