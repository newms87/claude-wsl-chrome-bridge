/**
 * Shared utilities barrel export
 */

export { createLogger, type Logger } from './logger.js';
export { createLifecycle, type Lifecycle, type CleanupFn } from './lifecycle.js';
export { VERSION, DEFAULT_BRIDGE_PORT, CHROME_EXTENSION_ID, NATIVE_HOST_NAME } from './constants.js';
