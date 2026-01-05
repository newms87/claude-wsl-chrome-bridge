# install-windows.ps1 - Register Chrome Native Messaging Host for Claude WSL Bridge
#
# Usage:
#   .\install-windows.ps1                  # Install
#   .\install-windows.ps1 -Uninstall       # Uninstall
#   .\install-windows.ps1 -InstallDir "C:\path\to\dir"  # Custom install directory
#
# This script:
# 1. Copies the native-host files to a local directory
# 2. Creates a native messaging manifest
# 3. Registers the manifest in the Windows Registry for Chrome

param(
    [string]$InstallDir = "$env:LOCALAPPDATA\ClaudeWSLBridge",
    [switch]$Uninstall
)

$ErrorActionPreference = "Stop"

# Configuration - must match what Claude's Chrome extension expects
$HostName = "com.anthropic.claude_code_browser_extension"
$ChromeExtensionId = "fcoeoabgfenejglbffodgkkbkcdhcgfn"
$RegistryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"

# Colored output helpers
function Write-Status {
    param([string]$Message)
    Write-Host "[*] " -NoNewline -ForegroundColor Cyan
    Write-Host $Message
}

function Write-Success {
    param([string]$Message)
    Write-Host "[+] " -NoNewline -ForegroundColor Green
    Write-Host $Message
}

function Write-Warn {
    param([string]$Message)
    Write-Host "[!] " -NoNewline -ForegroundColor Yellow
    Write-Host $Message
}

function Write-Err {
    param([string]$Message)
    Write-Host "[X] " -NoNewline -ForegroundColor Red
    Write-Host $Message
}

# Banner
Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  Claude WSL Chrome Bridge - Installer" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

# Uninstall mode
if ($Uninstall) {
    Write-Status "Uninstalling Claude WSL Chrome Bridge..."

    # Remove registry entry
    if (Test-Path $RegistryPath) {
        Remove-Item -Path $RegistryPath -Force
        Write-Success "Removed registry entry"
    } else {
        Write-Warn "Registry entry not found (already removed?)"
    }

    # Remove installation directory
    if (Test-Path $InstallDir) {
        Remove-Item -Path $InstallDir -Recurse -Force
        Write-Success "Removed installation directory: $InstallDir"
    } else {
        Write-Warn "Installation directory not found (already removed?)"
    }

    Write-Host ""
    Write-Success "Uninstallation complete!"
    Write-Host ""
    exit 0
}

# Install mode
Write-Status "Installing Claude WSL Chrome Bridge..."
Write-Status "Install directory: $InstallDir"
Write-Status "Registry path: $RegistryPath"
Write-Host ""

# Get script directory and project root
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptDir

# Check for required files
$DistDir = Join-Path $ProjectDir "dist"
$NativeHostJs = Join-Path $DistDir "native-host.js"

if (-not (Test-Path $NativeHostJs)) {
    Write-Err "native-host.js not found at: $NativeHostJs"
    Write-Err "Please run 'npm run build' in the project directory first."
    Write-Host ""
    Write-Host "Quick fix:" -ForegroundColor Yellow
    Write-Host "  cd $ProjectDir"
    Write-Host "  npm install"
    Write-Host "  npm run build"
    Write-Host ""
    exit 1
}

Write-Success "Found native-host.js"

# Create installation directory
if (-not (Test-Path $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    Write-Success "Created installation directory"
} else {
    Write-Warn "Installation directory already exists, will overwrite files"
}

# Copy native-host.js
Copy-Item -Path $NativeHostJs -Destination $InstallDir -Force
Write-Success "Copied native-host.js"

# Also copy protocol.js if it exists (in case we need separate modules)
$ProtocolJs = Join-Path $DistDir "protocol.js"
if (Test-Path $ProtocolJs) {
    Copy-Item -Path $ProtocolJs -Destination $InstallDir -Force
    Write-Success "Copied protocol.js"
}

# Create batch launcher script
# Chrome will execute this .bat file, which in turn runs Node.js
$LauncherPath = Join-Path $InstallDir "native-host.bat"
$LauncherContent = @"
@echo off
REM Claude WSL Chrome Bridge - Native Host Launcher
REM This script is executed by Chrome via Native Messaging

REM Run the Node.js native host
node "%~dp0native-host.js" %*
"@

Set-Content -Path $LauncherPath -Value $LauncherContent -Encoding ASCII
Write-Success "Created launcher: native-host.bat"

# Create native messaging manifest
$ManifestPath = Join-Path $InstallDir "manifest.json"
$Manifest = @{
    name = $HostName
    description = "Claude WSL Chrome Bridge - Connects Claude Code in WSL to Chrome extension"
    path = $LauncherPath
    type = "stdio"
    allowed_origins = @("chrome-extension://$ChromeExtensionId/")
}

$ManifestJson = $Manifest | ConvertTo-Json -Depth 10
Set-Content -Path $ManifestPath -Value $ManifestJson -Encoding UTF8
Write-Success "Created manifest: manifest.json"

# Register with Chrome via Registry
# Create parent key if needed
$ParentPath = Split-Path $RegistryPath
if (-not (Test-Path $ParentPath)) {
    New-Item -Path $ParentPath -Force | Out-Null
}

# Set the registry value
if (Test-Path $RegistryPath) {
    # Update existing
    Set-ItemProperty -Path $RegistryPath -Name "(Default)" -Value $ManifestPath -Force
} else {
    # Create new
    New-Item -Path $RegistryPath -Force | Out-Null
    Set-ItemProperty -Path $RegistryPath -Name "(Default)" -Value $ManifestPath
}
Write-Success "Registered with Chrome in registry"

# Verify installation
Write-Host ""
Write-Status "Verifying installation..."

$Success = $true
$Errors = @()

# Check registry
$RegValue = (Get-ItemProperty -Path $RegistryPath -ErrorAction SilentlyContinue).'(Default)'
if ($RegValue -ne $ManifestPath) {
    $Success = $false
    $Errors += "Registry value mismatch"
}

# Check manifest exists
if (-not (Test-Path $ManifestPath)) {
    $Success = $false
    $Errors += "Manifest file missing"
}

# Check launcher exists
if (-not (Test-Path $LauncherPath)) {
    $Success = $false
    $Errors += "Launcher script missing"
}

# Check native-host.js exists
$InstalledNativeHost = Join-Path $InstallDir "native-host.js"
if (-not (Test-Path $InstalledNativeHost)) {
    $Success = $false
    $Errors += "native-host.js missing"
}

# Check Node.js is available
try {
    $NodeVersion = & node --version 2>&1
    Write-Success "Node.js found: $NodeVersion"
} catch {
    $Success = $false
    $Errors += "Node.js not found in PATH"
}

if ($Success) {
    Write-Host ""
    Write-Success "Installation verified successfully!"
    Write-Host ""
    Write-Host "============================================" -ForegroundColor Green
    Write-Host "  Installation Complete!" -ForegroundColor Green
    Write-Host "============================================" -ForegroundColor Green
    Write-Host ""
    Write-Host "Next steps:" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "1. Restart Chrome if it's currently running"
    Write-Host ""
    Write-Host "2. The bridge will start automatically when the Claude"
    Write-Host "   extension connects. You can also run it manually:"
    Write-Host ""
    Write-Host "   node `"$InstalledNativeHost`"" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "3. In WSL, run the install-wsl.sh script to configure"
    Write-Host "   Claude Code to use the relay."
    Write-Host ""
} else {
    Write-Host ""
    Write-Err "Installation verification failed!"
    foreach ($e in $Errors) {
        Write-Err "  - $e"
    }
    Write-Host ""
    exit 1
}
