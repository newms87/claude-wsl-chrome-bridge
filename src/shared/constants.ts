/**
 * Shared runtime constants
 *
 * Note: Chrome extension ID and native host name are only used during installation
 * and are defined in scripts/build-installer.js, not here.
 */

// Version is injected at build time via esbuild --define:__VERSION__
declare const __VERSION__: string;
export const VERSION = typeof __VERSION__ !== 'undefined' ? __VERSION__ : 'dev';

/** Default TCP port for Windows-WSL bridge communication */
export const DEFAULT_BRIDGE_PORT = 9333;
