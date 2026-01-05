/**
 * Shared constants
 */

// Version is injected at build time by esbuild --define
declare const __VERSION__: string;
export const VERSION = typeof __VERSION__ !== 'undefined' ? __VERSION__ : 'dev';

export const DEFAULT_BRIDGE_PORT = 9333;

export const CHROME_EXTENSION_ID = 'fcoeoabgfenejglbffodgkkbkcdhcgfn';

export const NATIVE_HOST_NAME = 'com.anthropic.claude_code_browser_extension';
