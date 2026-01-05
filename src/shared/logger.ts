/**
 * Shared logging utilities
 *
 * All loggers write to stderr (stdout is reserved for Native Messaging protocol).
 * File logging is optional and used by native-host on Windows for debugging.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface Logger {
  log: (message: string) => void;
  debug: (message: string) => void;
  error: (context: string, error: unknown) => void;
}

export interface FileLoggerOptions {
  /** Directory to write log file */
  logDir: string;
  /** Log filename */
  filename: string;
  /** Clear log on startup (keeps previous as .old) */
  clearOnStartup?: boolean;
}

/**
 * Format an error for logging
 */
export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Get current timestamp in ISO format
 */
function timestamp(): string {
  return new Date().toISOString();
}

/**
 * Format a log line with component and timestamp
 */
function formatLine(component: string, message: string): string {
  return `[${component}] ${timestamp()} ${message}\n`;
}

/**
 * Create a logger that writes to stderr only
 */
export function createLogger(component: string, debugEnabled = false): Logger {
  const log = (message: string): void => {
    process.stderr.write(formatLine(component, message));
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

/**
 * Create a logger that writes to both stderr and a file
 * Used by native-host on Windows where stderr isn't easily visible
 */
export function createFileLogger(
  component: string,
  debugEnabled: boolean,
  options: FileLoggerOptions
): Logger {
  const logFile = path.join(options.logDir, options.filename);

  // Ensure log directory exists
  try {
    fs.mkdirSync(options.logDir, { recursive: true });
  } catch {
    // Directory may already exist
  }

  // Optionally clear log on startup
  if (options.clearOnStartup) {
    try {
      if (fs.existsSync(logFile)) {
        fs.renameSync(logFile, logFile + '.old');
      }
    } catch {
      // Ignore rename errors
    }
  }

  const logStream = fs.createWriteStream(logFile, { flags: 'a' });
  const baseLogger = createLogger(component, debugEnabled);

  const writeToFile = (message: string): void => {
    logStream.write(formatLine(component, message));
  };

  return {
    log: (message: string): void => {
      baseLogger.log(message);
      writeToFile(message);
    },
    debug: (message: string): void => {
      baseLogger.debug(message);
      if (debugEnabled) {
        writeToFile(`DEBUG: ${message}`);
      }
    },
    error: (context: string, error: unknown): void => {
      baseLogger.error(context, error);
      writeToFile(`ERROR [${context}]: ${formatError(error)}`);
    },
  };
}
