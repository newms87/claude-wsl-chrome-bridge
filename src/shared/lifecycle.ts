/**
 * Shared lifecycle management utilities
 */

import type { Logger } from './logger.js';

export interface CleanupFn {
  (): void;
}

/**
 * Create a lifecycle manager that handles graceful shutdown
 */
export function createLifecycle(logger: Logger) {
  let shuttingDown = false;
  const cleanupFns: CleanupFn[] = [];

  const cleanup = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.log('Cleaning up...');

    for (const fn of cleanupFns) {
      try {
        fn();
      } catch {
        // Ignore cleanup errors
      }
    }

    setTimeout(() => process.exit(0), 100);
  };

  // Register signal handlers
  process.on('SIGINT', () => {
    logger.log('Received SIGINT');
    cleanup();
  });
  process.on('SIGTERM', () => {
    logger.log('Received SIGTERM');
    cleanup();
  });
  process.on('SIGHUP', () => {
    logger.log('Received SIGHUP');
    cleanup();
  });
  process.on('uncaughtException', (err) => {
    logger.error('uncaughtException', err);
    cleanup();
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandledRejection', reason);
  });

  return {
    /**
     * Register a cleanup function to be called on shutdown
     */
    onCleanup: (fn: CleanupFn): void => {
      cleanupFns.push(fn);
    },

    /**
     * Trigger graceful shutdown
     */
    shutdown: cleanup,

    /**
     * Check if shutdown is in progress
     */
    isShuttingDown: (): boolean => shuttingDown,
  };
}

export type Lifecycle = ReturnType<typeof createLifecycle>;
