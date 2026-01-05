/**
 * Native Messaging Host - Bridges Chrome to WSL Claude
 *
 * Architecture:
 *   Chrome ↔ native-host (this) ↔ TCP:9333 ↔ WSL Relay ↔ Claude
 *
 * This is a PERSISTENT process - Chrome keeps it alive as long as we
 * respond to ping/get_status messages.
 */

import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import {
  MessageDecoder,
  RawMessageAccumulator,
  encodeMessage,
  LENGTH_PREFIX_SIZE,
} from './protocol.js';
import { createLogger, createLifecycle, VERSION, DEFAULT_BRIDGE_PORT } from './shared/index.js';

// Configuration
const WSL_PORT = parseInt(process.env.CLAUDE_BRIDGE_PORT || String(DEFAULT_BRIDGE_PORT), 10);
const DEBUG = process.env.CLAUDE_BRIDGE_DEBUG === '1';

// Setup file logging (in addition to stderr)
const LOG_FILE = path.join(
  process.env.LOCALAPPDATA || process.env.HOME || '.',
  'ClaudeWSLBridge',
  'native-host.log'
);

// Ensure log directory exists
try {
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
} catch {
  // Ignore
}

// Clear log on startup (keep previous run as .old for debugging)
try {
  if (fs.existsSync(LOG_FILE)) {
    // Keep previous log for reference
    fs.renameSync(LOG_FILE, LOG_FILE + '.old');
  }
} catch {
  // Ignore
}

const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });

// Custom logger that writes to both stderr and file
function createFileLogger(component: string, debugEnabled: boolean) {
  const baseLogger = createLogger(component, debugEnabled);
  const writeToFile = (message: string): void => {
    logStream.write(`[${component}] ${new Date().toISOString()} ${message}\n`);
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
      const errMsg = error instanceof Error ? error.message : String(error);
      writeToFile(`ERROR [${context}]: ${errMsg}`);
    },
  };
}

// Initialize shared utilities
const logger = createFileLogger('native-host', DEBUG);
const lifecycle = createLifecycle(logger);

// State
let wslServer: net.Server | null = null;
let wslClient: net.Socket | null = null;
const chromeDecoder = new MessageDecoder();
const wslAccumulator = new RawMessageAccumulator();
const pendingForWsl: Buffer[] = [];

// Register cleanup handlers
lifecycle.onCleanup(() => {
  if (wslClient) {
    wslClient.destroy();
    wslClient = null;
  }
});
lifecycle.onCleanup(() => {
  if (wslServer) {
    wslServer.close();
    wslServer = null;
  }
});

/**
 * Send message to Chrome via stdout (Native Messaging protocol)
 */
function sendToChrome(message: unknown): void {
  try {
    const encoded = encodeMessage(message);
    logger.debug(`Sending to Chrome: ${JSON.stringify(message).slice(0, 200)}`);
    process.stdout.write(encoded);
  } catch (err) {
    logger.error('sendToChrome', err);
  }
}

/**
 * Forward a framed message to WSL relay
 */
function forwardToWsl(frame: Buffer): void {
  if (wslClient && !wslClient.destroyed) {
    logger.debug(`Forwarding to WSL: ${frame.length} bytes`);
    wslClient.write(frame);
  } else {
    logger.log(`WSL not connected yet, queuing message (${pendingForWsl.length + 1} pending)`);
    pendingForWsl.push(frame);
  }
}

/**
 * Flush pending messages to WSL when it connects
 */
function flushPendingToWsl(): void {
  if (pendingForWsl.length > 0 && wslClient && !wslClient.destroyed) {
    logger.log(`Flushing ${pendingForWsl.length} pending messages to WSL`);
    while (pendingForWsl.length > 0) {
      const frame = pendingForWsl.shift()!;
      wslClient.write(frame);
    }
  }
}

/**
 * Handle message received from Chrome extension
 */
function handleChromeMessage(message: unknown): void {
  const msg = message as { type?: string; [key: string]: unknown };
  logger.log(`Received from Chrome: ${JSON.stringify(msg).slice(0, 200)}`);

  // Handle Chrome protocol messages locally
  if (msg.type === 'ping') {
    logger.log('Responding to ping with pong');
    sendToChrome({ type: 'pong' });
    return;
  }

  if (msg.type === 'get_status') {
    logger.log('Responding to get_status');
    sendToChrome({
      type: 'status',
      connected: wslClient !== null && !wslClient.destroyed,
      version: VERSION,
    });
    return;
  }

  // Forward all other messages to WSL
  try {
    const encoded = encodeMessage(message);
    forwardToWsl(encoded);
  } catch (err) {
    logger.error('forward to WSL', err);
  }
}

/**
 * Setup stdin to receive Native Messaging from Chrome
 */
function setupChromeStdin(): void {
  logger.log('Setting up Chrome stdin listener...');

  process.stdin.on('data', (chunk: Buffer) => {
    logger.log(`Received ${chunk.length} bytes from Chrome stdin`);
    logger.debug(`Raw data (hex): ${chunk.toString('hex').slice(0, 100)}`);
    try {
      const messages = chromeDecoder.decode(chunk);
      logger.log(`Decoded ${messages.length} message(s) from Chrome`);
      for (const msg of messages) {
        handleChromeMessage(msg);
      }
    } catch (err) {
      logger.error('Chrome stdin decode', err);
    }
  });

  process.stdin.on('end', () => {
    logger.log('Chrome closed connection (stdin ended)');
    lifecycle.shutdown();
  });

  process.stdin.on('error', (err) => {
    logger.error('Chrome stdin', err);
    lifecycle.shutdown();
  });

  process.stdin.on('close', () => {
    logger.log('Chrome stdin closed');
    lifecycle.shutdown();
  });
}

/**
 * Setup TCP server for WSL relay connections
 */
function setupWslServer(): void {
  wslServer = net.createServer((socket) => {
    const clientAddr = `${socket.remoteAddress}:${socket.remotePort}`;
    logger.log(`WSL relay connected from ${clientAddr}`);

    // Only allow one WSL client at a time
    if (wslClient && !wslClient.destroyed) {
      logger.log('Replacing existing WSL connection');
      wslClient.destroy();
    }

    wslClient = socket;
    wslAccumulator.reset();
    flushPendingToWsl();

    socket.on('data', (chunk: Buffer) => {
      try {
        const frames = wslAccumulator.accumulate(chunk);
        for (const frame of frames) {
          const length = frame.readUInt32LE(0);
          const payload = frame.subarray(LENGTH_PREFIX_SIZE, LENGTH_PREFIX_SIZE + length);

          try {
            const message = JSON.parse(payload.toString('utf-8'));

            if (message?.type === 'bridge-ready') {
              logger.debug('Received bridge-ready from WSL (ignoring)');
              continue;
            }

            logger.log(`Message from WSL (${frame.length} bytes): ${payload.toString('utf-8').slice(0, 300)}`);
            sendToChrome(message);
          } catch {
            logger.error('WSL message parse', 'Invalid JSON, dropping message');
          }
        }
      } catch (err) {
        logger.error('WSL data processing', err);
      }
    });

    socket.on('close', () => {
      logger.log(`WSL relay disconnected: ${clientAddr}`);
      if (wslClient === socket) {
        wslClient = null;
        wslAccumulator.reset();
      }
    });

    socket.on('error', (err) => {
      logger.error(`WSL socket ${clientAddr}`, err);
    });

    // Send welcome message
    const welcome = encodeMessage({
      type: 'bridge-ready',
      version: VERSION,
      port: WSL_PORT,
    });
    socket.write(welcome);
  });

  wslServer.on('error', (err) => {
    logger.error('WSL server', err);
    const errWithCode = err as NodeJS.ErrnoException;
    if (errWithCode.code === 'EADDRINUSE') {
      logger.log(`FATAL: Port ${WSL_PORT} already in use`);
      sendToChrome({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: `Port ${WSL_PORT} already in use. Is another native-host running?`,
        },
      });
      lifecycle.shutdown();
    }
  });

  wslServer.listen(WSL_PORT, '0.0.0.0', () => {
    logger.log(`WSL server listening on 0.0.0.0:${WSL_PORT}`);
  });
}

function main(): void {
  logger.log('='.repeat(60));
  logger.log('Claude WSL Chrome Bridge - Native Host');
  logger.log(`Version: ${VERSION}`);
  logger.log(`WSL Port: ${WSL_PORT}`);
  logger.log(`Debug: ${DEBUG}`);
  logger.log('='.repeat(60));

  const args = process.argv.slice(2);
  if (args.length > 0) {
    logger.log(`Chrome extension origin: ${args[0]}`);
  }

  setupChromeStdin();
  setupWslServer();

  logger.log('Native host ready. Waiting for connections...');
}

main();
