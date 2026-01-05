# install.ps1 - Unified installer for Claude WSL Chrome Bridge
#
# Usage:
#   .\install.ps1                  # Install both Windows and WSL
#   .\install.ps1 -Uninstall       # Uninstall from both Windows and WSL
#   .\install.ps1 -WindowsOnly     # Install Windows side only
#   .\install.ps1 -WslOnly         # Install WSL side only
#
# This script:
# 1. Installs native-host.js on Windows with Chrome Native Messaging registration
# 2. Installs wsl-relay.js and claude-chrome command in WSL
# 3. Configures Windows Firewall

param(
    [string]$InstallDir = "$env:LOCALAPPDATA\ClaudeWSLBridge",
    [switch]$Uninstall,
    [switch]$WindowsOnly,
    [switch]$WslOnly
)

$ErrorActionPreference = "Stop"
$Version = "1.0.0"

# Configuration
$HostName = "com.anthropic.claude_code_browser_extension"
$ChromeExtensionId = "fcoeoabgfenejglbffodgkkbkcdhcgfn"
$RegistryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"
$BridgePort = 9333
$FirewallRuleName = "Claude WSL Chrome Bridge"

# WSL paths
$WslLibDir = '~/.local/lib/claude-chrome-bridge'
$WslBinDir = '~/.local/bin'

# Colored output helpers
function Write-Status { param([string]$Message) Write-Host "[*] " -NoNewline -ForegroundColor Cyan; Write-Host $Message }
function Write-Success { param([string]$Message) Write-Host "[+] " -NoNewline -ForegroundColor Green; Write-Host $Message }
function Write-Warn { param([string]$Message) Write-Host "[!] " -NoNewline -ForegroundColor Yellow; Write-Host $Message }
function Write-Err { param([string]$Message) Write-Host "[X] " -NoNewline -ForegroundColor Red; Write-Host $Message }

# Banner
Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  Claude WSL Chrome Bridge - Installer v$Version" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

# Get script directory and project root
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptDir
$DistDir = Join-Path $ProjectDir "dist"

# ============================================================================
# UNINSTALL
# ============================================================================
if ($Uninstall) {
    Write-Status "Uninstalling Claude WSL Chrome Bridge..."

    if (-not $WslOnly) {
        # Windows: Remove registry entry
        if (Test-Path $RegistryPath) {
            Remove-Item -Path $RegistryPath -Force
            Write-Success "Removed Chrome registry entry"
        }

        # Windows: Remove firewall rule
        try {
            $existingRule = Get-NetFirewallRule -DisplayName $FirewallRuleName -ErrorAction SilentlyContinue
            if ($existingRule) {
                Remove-NetFirewallRule -DisplayName $FirewallRuleName
                Write-Success "Removed firewall rule"
            }
        } catch {
            Write-Warn "Could not remove firewall rule (may require admin)"
        }

        # Windows: Remove installation directory
        if (Test-Path $InstallDir) {
            Remove-Item -Path $InstallDir -Recurse -Force
            Write-Success "Removed Windows installation: $InstallDir"
        }
    }

    if (-not $WindowsOnly) {
        # WSL: Remove files
        Write-Status "Removing WSL components..."
        $wslCommands = @"
rm -rf $WslLibDir 2>/dev/null
rm -f $WslBinDir/claude-chrome 2>/dev/null
echo 'WSL cleanup complete'
"@
        wsl.exe bash -c $wslCommands
        Write-Success "Removed WSL components"
    }

    Write-Host ""
    Write-Success "Uninstallation complete!"
    Write-Host ""
    exit 0
}

# ============================================================================
# INSTALL - WINDOWS
# ============================================================================
if (-not $WslOnly) {
    Write-Status "Installing Windows components..."

    # Check for required files
    $NativeHostJs = Join-Path $DistDir "native-host.js"
    if (-not (Test-Path $NativeHostJs)) {
        Write-Err "native-host.js not found at: $NativeHostJs"
        Write-Err "Please run 'npm run build' first."
        exit 1
    }

    # Create installation directory
    if (-not (Test-Path $InstallDir)) {
        New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
        Write-Success "Created directory: $InstallDir"
    }

    # Copy native-host.js
    Copy-Item -Path $NativeHostJs -Destination $InstallDir -Force
    Write-Success "Installed native-host.js"

    # Create batch launcher
    $LauncherPath = Join-Path $InstallDir "native-host.bat"
    $LauncherContent = @"
@echo off
node "%~dp0native-host.js" %*
"@
    Set-Content -Path $LauncherPath -Value $LauncherContent -Encoding ASCII
    Write-Success "Created launcher: native-host.bat"

    # Create native messaging manifest
    $ManifestPath = Join-Path $InstallDir "manifest.json"
    $Manifest = @{
        name = $HostName
        description = "Claude WSL Chrome Bridge v$Version"
        path = $LauncherPath
        type = "stdio"
        allowed_origins = @("chrome-extension://$ChromeExtensionId/")
    }
    $ManifestJson = $Manifest | ConvertTo-Json -Depth 10
    Set-Content -Path $ManifestPath -Value $ManifestJson -Encoding UTF8
    Write-Success "Created manifest.json"

    # Register with Chrome
    $ParentPath = Split-Path $RegistryPath
    if (-not (Test-Path $ParentPath)) {
        New-Item -Path $ParentPath -Force | Out-Null
    }
    if (Test-Path $RegistryPath) {
        Set-ItemProperty -Path $RegistryPath -Name "(Default)" -Value $ManifestPath -Force
    } else {
        New-Item -Path $RegistryPath -Force | Out-Null
        Set-ItemProperty -Path $RegistryPath -Name "(Default)" -Value $ManifestPath
    }
    Write-Success "Registered with Chrome"

    # Add firewall rule (requires admin, but try anyway)
    try {
        $existingRule = Get-NetFirewallRule -DisplayName $FirewallRuleName -ErrorAction SilentlyContinue
        if (-not $existingRule) {
            New-NetFirewallRule -DisplayName $FirewallRuleName `
                -Direction Inbound `
                -Protocol TCP `
                -LocalPort $BridgePort `
                -Action Allow `
                -Profile Private `
                -ErrorAction Stop | Out-Null
            Write-Success "Added firewall rule for port $BridgePort"
        } else {
            Write-Warn "Firewall rule already exists"
        }
    } catch {
        Write-Warn "Could not add firewall rule (run as admin if WSL can't connect)"
        Write-Warn "Manual: netsh advfirewall firewall add rule name=`"$FirewallRuleName`" dir=in action=allow protocol=tcp localport=$BridgePort"
    }

    # Verify Node.js
    try {
        $NodeVersion = & node --version 2>&1
        Write-Success "Node.js found: $NodeVersion"
    } catch {
        Write-Err "Node.js not found! Please install Node.js first."
        exit 1
    }

    Write-Success "Windows installation complete!"
    Write-Host ""
}

# ============================================================================
# INSTALL - WSL
# ============================================================================
if (-not $WindowsOnly) {
    Write-Status "Installing WSL components..."

    # Check for wsl-relay.js
    $WslRelayJs = Join-Path $DistDir "wsl-relay.js"
    if (-not (Test-Path $WslRelayJs)) {
        Write-Err "wsl-relay.js not found at: $WslRelayJs"
        Write-Err "Please run 'npm run build' first."
        exit 1
    }

    # Convert Windows path to WSL path
    $WslDistPath = wsl.exe wslpath -u $DistDir.Replace('\', '/')
    $WslDistPath = $WslDistPath.Trim()

    # Create claude-chrome script content
    $ClaudeChromeScript = @'
#!/bin/bash
# claude-chrome - Run Claude Code with Chrome integration via WSL bridge
set -e

RELAY_JS="$HOME/.local/lib/claude-chrome-bridge/wsl-relay.js"
LOG_FILE="/tmp/claude-wsl-relay.log"

# Check relay exists
if [[ ! -f "$RELAY_JS" ]]; then
    echo "ERROR: wsl-relay.js not found at $RELAY_JS"
    echo "Please reinstall the Claude WSL Chrome Bridge."
    exit 1
fi

# Cleanup function
cleanup() {
    rm -f "$FAKE_VERSION" 2>/dev/null
    if [[ -n "$RELAY_PID" ]] && kill -0 "$RELAY_PID" 2>/dev/null; then
        kill "$RELAY_PID" 2>/dev/null || true
    fi
}
trap cleanup EXIT INT TERM

# Start relay in background
> "$LOG_FILE"
node "$RELAY_JS" >> "$LOG_FILE" 2>&1 &
RELAY_PID=$!

sleep 1

if ! kill -0 "$RELAY_PID" 2>/dev/null; then
    echo "ERROR: WSL relay failed to start. Check $LOG_FILE for details."
    tail -20 "$LOG_FILE" 2>/dev/null
    exit 1
fi

# Create fake /proc/version to bypass WSL detection
FAKE_VERSION="/tmp/fake_proc_version_$$"
echo "Linux version 6.6.87-generic (build@linux) (gcc 11.4.0) #1 SMP $(date -u '+%c %Y')" > "$FAKE_VERSION"

# Run Claude in mount namespace with fake /proc/version
exec unshare --user --map-root-user -m bash -c "
    mount --bind '$FAKE_VERSION' /proc/version
    export CLAUDE_CODE_ENABLE_CFC=1
    exec claude \"\$@\"
" -- "$@"
'@

    # Install to WSL
    $wslInstallScript = @"
set -e

# Create directories
mkdir -p $WslLibDir
mkdir -p $WslBinDir

# Copy wsl-relay.js
cp "$WslDistPath/wsl-relay.js" "$WslLibDir/"

# Create claude-chrome command
cat > "$WslBinDir/claude-chrome" << 'SCRIPT_EOF'
$ClaudeChromeScript
SCRIPT_EOF

chmod +x "$WslBinDir/claude-chrome"

# Ensure ~/.local/bin is in PATH
if ! grep -q 'export PATH=.*\.local/bin' ~/.bashrc 2>/dev/null; then
    echo '' >> ~/.bashrc
    echo '# Added by Claude WSL Chrome Bridge' >> ~/.bashrc
    echo 'export PATH="\$HOME/.local/bin:\$PATH"' >> ~/.bashrc
fi

if [[ -f ~/.zshrc ]] && ! grep -q 'export PATH=.*\.local/bin' ~/.zshrc 2>/dev/null; then
    echo '' >> ~/.zshrc
    echo '# Added by Claude WSL Chrome Bridge' >> ~/.zshrc
    echo 'export PATH="\$HOME/.local/bin:\$PATH"' >> ~/.zshrc
fi

echo "WSL installation complete"
"@

    wsl.exe bash -c $wslInstallScript
    Write-Success "WSL installation complete!"
    Write-Host ""
}

# ============================================================================
# SUCCESS MESSAGE
# ============================================================================
Write-Host "============================================" -ForegroundColor Green
Write-Host "  Installation Complete!" -ForegroundColor Green
Write-Host "============================================" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host ""
Write-Host "1. " -NoNewline; Write-Host "Restart Chrome" -ForegroundColor Cyan
Write-Host "   (Close all Chrome windows and reopen)"
Write-Host ""
Write-Host "2. " -NoNewline; Write-Host "Open a new WSL terminal and run:" -ForegroundColor Cyan
Write-Host ""
Write-Host "   claude-chrome" -ForegroundColor Green
Write-Host ""
Write-Host "   This will start Claude Code with Chrome integration."
Write-Host ""
Write-Host "Troubleshooting:" -ForegroundColor Yellow
Write-Host "- If connection fails, check Windows Firewall allows port $BridgePort"
Write-Host "- Logs: /tmp/claude-wsl-relay.log (in WSL)"
Write-Host "- Debug: CLAUDE_BRIDGE_DEBUG=1 claude-chrome"
Write-Host ""
