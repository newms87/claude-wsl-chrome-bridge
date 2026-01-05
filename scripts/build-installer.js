#!/usr/bin/env node
/**
 * Build a self-contained installer with embedded JS files
 *
 * This script reads the built JS files and embeds them into a single
 * PowerShell installer script that can be distributed standalone.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.dirname(__dirname);
const distDir = path.join(projectDir, 'dist');

// Read version from package.json (single source of truth)
const packageJson = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf-8'));
const VERSION = packageJson.version;

// Read the built JS files
const nativeHostJs = fs.readFileSync(path.join(distDir, 'native-host.js'), 'utf-8');
const wslRelayJs = fs.readFileSync(path.join(distDir, 'wsl-relay.js'), 'utf-8');

// Escape for PowerShell here-string (only need to escape @' and '@)
function escapeForHereString(content) {
  // PowerShell here-strings are literal, but we use base64 to be safe
  return Buffer.from(content).toString('base64');
}

const nativeHostBase64 = escapeForHereString(nativeHostJs);
const wslRelayBase64 = escapeForHereString(wslRelayJs);

// Generate the self-contained installer
const installer = `# Claude WSL Chrome Bridge - Self-Contained Installer v${VERSION}
#
# Usage:
#   .\\install.ps1                  # Install
#   .\\install.ps1 -Uninstall       # Uninstall
#
# Or run directly from web:
#   irm https://raw.githubusercontent.com/user/repo/main/dist/install.ps1 | iex

param(
    [string]$InstallDir = "$env:LOCALAPPDATA\\ClaudeWSLBridge",
    [switch]$Uninstall,
    [switch]$Force
)

$ErrorActionPreference = "Stop"
$Version = "${VERSION}"

# Embedded files (base64 encoded)
$NativeHostBase64 = @'
${nativeHostBase64}
'@

$WslRelayBase64 = @'
${wslRelayBase64}
'@

# Chrome Native Messaging configuration
# These must match what Claude Code's Chrome extension expects
$HostName = "com.anthropic.claude_code_browser_extension"
$ChromeExtensionId = "fcoeoabgfenejglbffodgkkbkcdhcgfn"
$RegistryPath = "HKCU:\\Software\\Google\\Chrome\\NativeMessagingHosts\\$HostName"
$BridgePort = 9333
$FirewallRuleName = "Claude WSL Chrome Bridge"

# WSL paths
$WslLibDir = '~/.local/lib/claude-chrome-bridge'
$WslBinDir = '~/.local/bin'

# Helpers
function Write-Status { param([string]$Message) Write-Host "[*] " -NoNewline -ForegroundColor Cyan; Write-Host $Message }
function Write-Success { param([string]$Message) Write-Host "[+] " -NoNewline -ForegroundColor Green; Write-Host $Message }
function Write-Warn { param([string]$Message) Write-Host "[!] " -NoNewline -ForegroundColor Yellow; Write-Host $Message }
function Write-Err { param([string]$Message) Write-Host "[X] " -NoNewline -ForegroundColor Red; Write-Host $Message }

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  Claude WSL Chrome Bridge v$Version" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

# UNINSTALL
if ($Uninstall) {
    Write-Status "Uninstalling..."

    if (Test-Path $RegistryPath) { Remove-Item -Path $RegistryPath -Force; Write-Success "Removed registry entry" }

    try {
        $rule = Get-NetFirewallRule -DisplayName $FirewallRuleName -ErrorAction SilentlyContinue
        if ($rule) { Remove-NetFirewallRule -DisplayName $FirewallRuleName; Write-Success "Removed firewall rule" }
    } catch { }

    if (Test-Path $InstallDir) {
        # Try to remove, handle locked files
        try {
            Remove-Item -Path $InstallDir -Recurse -Force -ErrorAction Stop
            Write-Success "Removed $InstallDir"
        } catch {
            if ($Force) {
                Write-Warn "Files locked. Attempting to kill node processes..."
                Get-Process -Name "node" -ErrorAction SilentlyContinue | Where-Object {
                    $_.Path -like "*node*" -or $_.CommandLine -like "*native-host*"
                } | Stop-Process -Force -ErrorAction SilentlyContinue
                Start-Sleep -Seconds 1
                try {
                    Remove-Item -Path $InstallDir -Recurse -Force -ErrorAction Stop
                    Write-Success "Removed $InstallDir"
                } catch {
                    Write-Err "Still cannot remove $InstallDir"
                    Write-Err "Close Chrome completely and try again"
                    exit 1
                }
            } else {
                Write-Err "Cannot remove $InstallDir - files are in use"
                Write-Host ""
                Write-Host "The native-host is running (launched by Chrome)." -ForegroundColor Yellow
                Write-Host ""
                Write-Host "Options:" -ForegroundColor Yellow
                Write-Host "  1. Close Chrome completely, then run uninstall again"
                Write-Host "  2. Use -Force flag: " -NoNewline; Write-Host ".\install.ps1 -Uninstall -Force" -ForegroundColor Cyan
                Write-Host ""
                exit 1
            }
        }
    }

    wsl.exe bash -c "rm -rf $WslLibDir $WslBinDir/claude-chrome 2>/dev/null; echo 'WSL cleanup done'"

    Write-Success "Uninstallation complete!"
    exit 0
}

# INSTALL WINDOWS
Write-Status "Installing Windows components..."

if (-not (Test-Path $InstallDir)) { New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null }

# Decode and write native-host.js
$NativeHostContent = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($NativeHostBase64))
Set-Content -Path (Join-Path $InstallDir "native-host.js") -Value $NativeHostContent -Encoding UTF8
Write-Success "Installed native-host.js"

# Create launcher
Set-Content -Path (Join-Path $InstallDir "native-host.bat") -Value "@echo off\`r\`nnode \`"%~dp0native-host.js\`" %*" -Encoding ASCII
Write-Success "Created launcher"

# Create manifest (UTF8 without BOM - Chrome requires this)
$ManifestPath = Join-Path $InstallDir "manifest.json"
$Manifest = @{ name = $HostName; description = "Claude WSL Chrome Bridge"; path = (Join-Path $InstallDir "native-host.bat"); type = "stdio"; allowed_origins = @("chrome-extension://$ChromeExtensionId/") }
$ManifestJson = $Manifest | ConvertTo-Json
[System.IO.File]::WriteAllText($ManifestPath, $ManifestJson, (New-Object System.Text.UTF8Encoding $false))
Write-Success "Created manifest"

# Register with Chrome
$ParentPath = Split-Path $RegistryPath
if (-not (Test-Path $ParentPath)) { New-Item -Path $ParentPath -Force | Out-Null }
New-Item -Path $RegistryPath -Force | Out-Null
Set-ItemProperty -Path $RegistryPath -Name "(Default)" -Value $ManifestPath
Write-Success "Registered with Chrome"

# Firewall
try {
    $rule = Get-NetFirewallRule -DisplayName $FirewallRuleName -ErrorAction SilentlyContinue
    if (-not $rule) {
        New-NetFirewallRule -DisplayName $FirewallRuleName -Direction Inbound -Protocol TCP -LocalPort $BridgePort -Action Allow -Profile Private -ErrorAction Stop | Out-Null
        Write-Success "Added firewall rule"
    }
} catch { Write-Warn "Firewall rule may need admin rights" }

# Check Node.js
try { $null = & node --version 2>&1; Write-Success "Node.js found" } catch { Write-Err "Node.js required!"; exit 1 }

# INSTALL WSL
Write-Status "Installing WSL components..."

$WslRelayContent = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($WslRelayBase64))
$TempFile = [System.IO.Path]::GetTempFileName()
Set-Content -Path $TempFile -Value $WslRelayContent -Encoding UTF8
$WslTempPath = (wsl.exe wslpath -u ($TempFile -replace '\\\\', '/')).Trim()

$ClaudeChromeScript = @'
#!/bin/bash
set -e

VERSION="__BRIDGE_VERSION__"
RELAY_JS="$HOME/.local/lib/claude-chrome-bridge/wsl-relay.js"
LOG_FILE="/tmp/claude-wsl-relay.log"
WIN_LOG="/mnt/c/Users/$USER/AppData/Local/ClaudeWSLBridge/native-host.log"

echo ""
echo "========================================"
echo "  Claude WSL Chrome Bridge v$VERSION"
echo "========================================"
echo ""

# Check relay exists
if [[ ! -f "$RELAY_JS" ]]; then
    echo "ERROR: WSL relay not found at $RELAY_JS"
    echo "Please reinstall the bridge."
    exit 1
fi

# Cleanup handler
cleanup() {
    rm -f "$FAKE_VERSION" 2>/dev/null
    [[ -n "$RELAY_PID" ]] && kill "$RELAY_PID" 2>/dev/null
}
trap cleanup EXIT INT TERM

# Start relay
echo "[bridge] Starting WSL relay..."
echo "[bridge] Log file: $LOG_FILE"
> "$LOG_FILE"
node "$RELAY_JS" >> "$LOG_FILE" 2>&1 &
RELAY_PID=$!

# Wait for relay to start
sleep 1
if ! kill -0 "$RELAY_PID" 2>/dev/null; then
    echo ""
    echo "ERROR: WSL relay failed to start!"
    echo ""
    echo "Last 10 lines of log:"
    tail -10 "$LOG_FILE" 2>/dev/null || true
    echo ""
    echo "Troubleshooting:"
    echo "  1. Make sure Chrome is open"
    echo "  2. Click the Claude extension icon in Chrome"
    echo "  3. Check Windows log: $WIN_LOG"
    exit 1
fi

echo "[bridge] WSL relay started (PID: $RELAY_PID)"
echo "[bridge] Connecting to Windows bridge..."
echo ""

# Wait briefly for connection (relay logs to file)
sleep 1
if grep -q "Connected to Windows bridge" "$LOG_FILE" 2>/dev/null; then
    echo "[bridge] Connected to Windows!"
elif grep -q "Connection attempt" "$LOG_FILE" 2>/dev/null; then
    echo "[bridge] Waiting for Windows native-host..."
    echo "[bridge] Make sure Chrome is open and click the Claude extension"
    echo ""
fi

# Setup fake /proc/version
FAKE_VERSION="/tmp/fake_proc_version_$$"
echo "Linux version 6.6.87-generic" > "$FAKE_VERSION"

# Run Claude with Chrome integration
exec unshare --user --map-root-user -m bash -c "mount --bind '$FAKE_VERSION' /proc/version; export CLAUDE_CODE_ENABLE_CFC=1; exec claude \"\$@\"" -- "$@"
'@

# Write claude-chrome script to temp file (UTF8 without BOM)
$ClaudeChromeTemp = [System.IO.Path]::GetTempFileName()
$Utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($ClaudeChromeTemp, $ClaudeChromeScript, $Utf8NoBom)
$WslClaudeChromeTemp = (wsl.exe wslpath -u ($ClaudeChromeTemp -replace '\\\\', '/')).Trim()

# Write WSL install script to temp file (avoids quoting issues with bash -c)
$WslInstallScript = @'
#!/bin/bash
set -e
RELAY_SRC="$1"
CLAUDE_CHROME_SRC="$2"
LIB_DIR="$HOME/.local/lib/claude-chrome-bridge"
BIN_DIR="$HOME/.local/bin"
mkdir -p "$LIB_DIR" "$BIN_DIR"
cp "$RELAY_SRC" "$LIB_DIR/wsl-relay.js"
cp "$CLAUDE_CHROME_SRC" "$BIN_DIR/claude-chrome"
chmod +x "$BIN_DIR/claude-chrome"
grep -q '.local/bin' ~/.bashrc 2>/dev/null || echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
[[ -f ~/.zshrc ]] && ! grep -q '.local/bin' ~/.zshrc && echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
echo "WSL done"
'@

$WslInstallTemp = [System.IO.Path]::GetTempFileName()
[System.IO.File]::WriteAllText($WslInstallTemp, $WslInstallScript, $Utf8NoBom)
$WslInstallPath = (wsl.exe wslpath -u ($WslInstallTemp -replace '\\\\', '/')).Trim()

wsl.exe bash "$WslInstallPath" "$WslTempPath" "$WslClaudeChromeTemp"
Remove-Item $WslInstallTemp -Force
Remove-Item $ClaudeChromeTemp -Force
Remove-Item $TempFile -Force
Write-Success "WSL installation complete!"

Write-Host ""
Write-Host "============================================" -ForegroundColor Green
Write-Host "  Installation Complete!" -ForegroundColor Green
Write-Host "============================================" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "1. Restart Chrome"
Write-Host "2. In WSL run: " -NoNewline; Write-Host "claude-chrome" -ForegroundColor Green
Write-Host ""
`;

// Write the self-contained installer (replace version placeholder in claude-chrome script)
const outputPath = path.join(distDir, 'install.ps1');
const finalInstaller = installer.replace(/__BRIDGE_VERSION__/g, VERSION);
fs.writeFileSync(outputPath, finalInstaller);

console.log(`Generated self-contained installer: ${outputPath}`);
console.log(`  native-host.js: ${Math.round(nativeHostJs.length / 1024)}kb`);
console.log(`  wsl-relay.js: ${Math.round(wslRelayJs.length / 1024)}kb`);
console.log(`  Total installer: ${Math.round(installer.length / 1024)}kb`);
