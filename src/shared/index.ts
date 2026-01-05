/**
 * Shared utilities barrel export
 */

export {
  createLogger,
  createFileLogger,
  formatError,
  type Logger,
  type FileLoggerOptions,
} from './logger.js';
export { createLifecycle, type Lifecycle, type CleanupFn } from './lifecycle.js';
export { VERSION, DEFAULT_BRIDGE_PORT } from './constants.js';

/**
 * Async sleep utility
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
