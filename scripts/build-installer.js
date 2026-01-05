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

const VERSION = '1.0.3';

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

# Configuration
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
Set-Content -Path (Join-Path $InstallDir "native-host.bat") -Value '@echo off\\nnode "%~dp0native-host.js" %*' -Encoding ASCII
Write-Success "Created launcher"

# Create manifest
$ManifestPath = Join-Path $InstallDir "manifest.json"
$Manifest = @{ name = $HostName; description = "Claude WSL Chrome Bridge"; path = (Join-Path $InstallDir "native-host.bat"); type = "stdio"; allowed_origins = @("chrome-extension://$ChromeExtensionId/") }
$Manifest | ConvertTo-Json | Set-Content -Path $ManifestPath -Encoding UTF8
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
RELAY_JS="$HOME/.local/lib/claude-chrome-bridge/wsl-relay.js"
LOG_FILE="/tmp/claude-wsl-relay.log"
[[ ! -f "$RELAY_JS" ]] && echo "ERROR: Relay not found" && exit 1
cleanup() { rm -f "$FAKE_VERSION" 2>/dev/null; [[ -n "$RELAY_PID" ]] && kill "$RELAY_PID" 2>/dev/null; }
trap cleanup EXIT INT TERM
> "$LOG_FILE"; node "$RELAY_JS" >> "$LOG_FILE" 2>&1 & RELAY_PID=$!
sleep 1; kill -0 "$RELAY_PID" 2>/dev/null || { echo "Relay failed. See $LOG_FILE"; exit 1; }
FAKE_VERSION="/tmp/fake_proc_version_$$"
echo "Linux version 6.6.87-generic" > "$FAKE_VERSION"
exec unshare --user --map-root-user -m bash -c "mount --bind '$FAKE_VERSION' /proc/version; export CLAUDE_CODE_ENABLE_CFC=1; exec claude \\"\$@\\"" -- "$@"
'@

# Write claude-chrome script to temp file (UTF8 without BOM)
$ClaudeChromeTemp = [System.IO.Path]::GetTempFileName()
$Utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($ClaudeChromeTemp, $ClaudeChromeScript, $Utf8NoBom)
$WslClaudeChromeTemp = (wsl.exe wslpath -u ($ClaudeChromeTemp -replace '\\\\', '/')).Trim()

$WslInstall = @"
set -e
mkdir -p $WslLibDir $WslBinDir
cp "$WslTempPath" "$WslLibDir/wsl-relay.js"
cp "$WslClaudeChromeTemp" "$WslBinDir/claude-chrome"
chmod +x "$WslBinDir/claude-chrome"
grep -q '.local/bin' ~/.bashrc 2>/dev/null || echo 'export PATH="\$HOME/.local/bin:\$PATH"' >> ~/.bashrc
[[ -f ~/.zshrc ]] && ! grep -q '.local/bin' ~/.zshrc && echo 'export PATH="\$HOME/.local/bin:\$PATH"' >> ~/.zshrc
echo "WSL done"
"@

wsl.exe bash -c $WslInstall
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

// Write the self-contained installer
const outputPath = path.join(distDir, 'install.ps1');
fs.writeFileSync(outputPath, installer);

console.log(`Generated self-contained installer: ${outputPath}`);
console.log(`  native-host.js: ${Math.round(nativeHostJs.length / 1024)}kb`);
console.log(`  wsl-relay.js: ${Math.round(wslRelayJs.length / 1024)}kb`);
console.log(`  Total installer: ${Math.round(installer.length / 1024)}kb`);
