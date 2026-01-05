/**
 * Shared logging utilities
 */

export interface Logger {
  log: (message: string) => void;
  debug: (message: string) => void;
  error: (context: string, error: unknown) => void;
}

/**
 * Format an error for logging
 */
function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Get current timestamp in ISO format
 */
function timestamp(): string {
  return new Date().toISOString();
}

/**
 * Create a logger for a specific component
 * All output goes to stderr (stdout reserved for Native Messaging protocol)
 */
export function createLogger(component: string, debugEnabled = false): Logger {
  const log = (message: string): void => {
    process.stderr.write(`[${component}] ${timestamp()} ${message}\n`);
  };

  return {
    log,
    debug: (message: string): void => {
      if (debugEnabled) {
        log(`DEBUG: ${message}`);
      }
    },
    error: (context: string, error: unknown): void => {
      log(`ERROR [${context}]: ${formatError(error)}`);
    },
  };
}
