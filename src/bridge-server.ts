/**
 * Bridge Server - Persistent message broker between Chrome and WSL
 *
 * This process runs persistently and:
 * 1. Listens on TCP:9333 for WSL relay connections
 * 2. Listens on TCP:9334 (localhost) for native-host handlers
 * 3. Bridges messages between them
 *
 * Architecture:
 *   Chrome ↔ native-host-handler ↔ Bridge Server ↔ WSL Relay ↔ Claude
 *
 * The native-host handlers are short-lived (spawned by Chrome), but this
 * bridge server persists and maintains the WSL connection.
 */

import * as net from 'net';
import {
  RawMessageAccumulator,
  encodeMessage,
  LENGTH_PREFIX_SIZE,
} from './protocol.js';

// Configuration
const WSL_PORT = parseInt(process.env.CLAUDE_BRIDGE_PORT || '9333', 10);
const HANDLER_PORT = parseInt(process.env.CLAUDE_BRIDGE_HANDLER_PORT || '9334', 10);
const DEBUG = process.env.CLAUDE_BRIDGE_DEBUG === '1';

// State
let wslClient: net.Socket | null = null;
let chromeHandler: net.Socket | null = null;
let wslServer: net.Server | null = null;
let handlerServer: net.Server | null = null;
const wslAccumulator = new RawMessageAccumulator();
const handlerAccumulator = new RawMessageAccumulator();
let shuttingDown = false;

// Message queue for when Chrome handler isn't connected
const pendingForChrome: Buffer[] = [];

function log(message: string): void {
  const timestamp = new Date().toISOString();
  console.log(`[bridge-server] ${timestamp} ${message}`);
}

function debug(message: string): void {
  if (DEBUG) {
    log(`DEBUG: ${message}`);
  }
}

function logError(context: string, error: unknown): void {
  const msg = error instanceof Error ? error.message : String(error);
  log(`ERROR [${context}]: ${msg}`);
}

/**
 * Forward a framed message to the Chrome handler
 */
function forwardToChrome(frame: Buffer): void {
  // Log the message content for debugging
  try {
    const length = frame.readUInt32LE(0);
    const payload = frame.subarray(LENGTH_PREFIX_SIZE, LENGTH_PREFIX_SIZE + length);
    log(`Message for Chrome (${frame.length} bytes): ${payload.toString('utf-8').slice(0, 300)}`);
  } catch { /* ignore parse errors */ }

  if (chromeHandler && !chromeHandler.destroyed) {
    chromeHandler.write(frame);
  } else {
    log(`Chrome handler not connected, queuing message (${pendingForChrome.length + 1} pending)`);
    pendingForChrome.push(frame);
  }
}

/**
 * Forward a framed message to the WSL relay
 */
function forwardToWsl(frame: Buffer): void {
  if (wslClient && !wslClient.destroyed) {
    debug(`Forwarding to WSL: ${frame.length} bytes`);
    wslClient.write(frame);
  } else {
    log('WARNING: WSL not connected, dropping message');
  }
}

/**
 * Flush pending messages to a newly connected Chrome handler
 */
function flushPendingToChrome(): void {
  if (pendingForChrome.length > 0 && chromeHandler && !chromeHandler.destroyed) {
    log(`Flushing ${pendingForChrome.length} pending messages to Chrome handler`);
    while (pendingForChrome.length > 0) {
      const frame = pendingForChrome.shift()!;
      chromeHandler.write(frame);
    }
  }
}

/**
 * Setup TCP server for WSL relay connections (port 9333)
 */
function setupWslServer(): void {
  wslServer = net.createServer((socket) => {
    const clientAddr = `${socket.remoteAddress}:${socket.remotePort}`;
    log(`WSL relay connected from ${clientAddr}`);

    // Only allow one WSL client at a time
    if (wslClient && !wslClient.destroyed) {
      log('Replacing existing WSL connection');
      wslClient.destroy();
    }

    wslClient = socket;
    wslAccumulator.reset();

    // Handle incoming data from WSL
    socket.on('data', (chunk: Buffer) => {
      try {
        const frames = wslAccumulator.accumulate(chunk);
        for (const frame of frames) {
          // Check for internal bridge messages
          const length = frame.readUInt32LE(0);
          const payload = frame.subarray(LENGTH_PREFIX_SIZE, LENGTH_PREFIX_SIZE + length);

          try {
            const message = JSON.parse(payload.toString('utf-8'));
            if (message?.type === 'bridge-ready') {
              debug('Received bridge-ready from WSL (ignoring)');
              continue;
            }
          } catch {
            // Not JSON or parse error, forward anyway
          }

          // Forward to Chrome handler
          forwardToChrome(frame);
        }
      } catch (err) {
        logError('WSL data processing', err);
      }
    });

    socket.on('close', () => {
      log(`WSL relay disconnected: ${clientAddr}`);
      if (wslClient === socket) {
        wslClient = null;
        wslAccumulator.reset();
      }
    });

    socket.on('error', (err) => {
      logError(`WSL socket ${clientAddr}`, err);
    });

    // Send welcome message
    const welcome = encodeMessage({
      type: 'bridge-ready',
      version: '1.0.0',
      wslPort: WSL_PORT,
      handlerPort: HANDLER_PORT,
    });
    socket.write(welcome);
  });

  wslServer.on('error', (err) => {
    logError('WSL server', err);
    const errWithCode = err as NodeJS.ErrnoException;
    if (errWithCode.code === 'EADDRINUSE') {
      log(`FATAL: Port ${WSL_PORT} already in use`);
      process.exit(1);
    }
  });

  wslServer.listen(WSL_PORT, '0.0.0.0', () => {
    log(`WSL server listening on 0.0.0.0:${WSL_PORT}`);
  });
}

/**
 * Setup TCP server for native-host handler connections (port 9334, localhost only)
 */
function setupHandlerServer(): void {
  handlerServer = net.createServer((socket) => {
    const clientAddr = `${socket.remoteAddress}:${socket.remotePort}`;
    log(`Chrome handler connected from ${clientAddr}`);

    // Replace existing handler (Chrome might have spawned a new one)
    if (chromeHandler && !chromeHandler.destroyed) {
      debug('Replacing existing Chrome handler');
      chromeHandler.destroy();
    }

    chromeHandler = socket;
    handlerAccumulator.reset();

    // Flush any pending messages
    flushPendingToChrome();

    // Handle incoming data from Chrome handler
    socket.on('data', (chunk: Buffer) => {
      try {
        const frames = handlerAccumulator.accumulate(chunk);
        for (const frame of frames) {
          // Log message from Chrome
          try {
            const length = frame.readUInt32LE(0);
            const payload = frame.subarray(LENGTH_PREFIX_SIZE, LENGTH_PREFIX_SIZE + length);
            log(`Message FROM Chrome (${frame.length} bytes): ${payload.toString('utf-8').slice(0, 300)}`);
          } catch { /* ignore */ }

          // Forward to WSL
          forwardToWsl(frame);
        }
      } catch (err) {
        logError('Handler data processing', err);
      }
    });

    socket.on('close', () => {
      log(`Chrome handler disconnected: ${clientAddr}`);
      if (chromeHandler === socket) {
        chromeHandler = null;
        handlerAccumulator.reset();
      }
    });

    socket.on('error', (err) => {
      logError(`Handler socket ${clientAddr}`, err);
    });

    // Send ready message to handler
    const ready = encodeMessage({
      type: 'handler-ready',
      wslConnected: wslClient !== null && !wslClient.destroyed,
    });
    socket.write(ready);
  });

  handlerServer.on('error', (err) => {
    logError('Handler server', err);
    const errWithCode = err as NodeJS.ErrnoException;
    if (errWithCode.code === 'EADDRINUSE') {
      log(`FATAL: Port ${HANDLER_PORT} already in use`);
      process.exit(1);
    }
  });

  // Only listen on localhost for security
  handlerServer.listen(HANDLER_PORT, '127.0.0.1', () => {
    log(`Handler server listening on 127.0.0.1:${HANDLER_PORT}`);
  });
}

function cleanup(): void {
  if (shuttingDown) return;
  shuttingDown = true;

  log('Cleaning up...');

  if (wslClient) {
    try { wslClient.destroy(); } catch { /* ignore */ }
    wslClient = null;
  }

  if (chromeHandler) {
    try { chromeHandler.destroy(); } catch { /* ignore */ }
    chromeHandler = null;
  }

  if (wslServer) {
    try { wslServer.close(); } catch { /* ignore */ }
    wslServer = null;
  }

  if (handlerServer) {
    try { handlerServer.close(); } catch { /* ignore */ }
    handlerServer = null;
  }

  setTimeout(() => process.exit(0), 100);
}

process.on('SIGINT', () => { log('Received SIGINT'); cleanup(); });
process.on('SIGTERM', () => { log('Received SIGTERM'); cleanup(); });
process.on('uncaughtException', (err) => { logError('uncaughtException', err); cleanup(); });
process.on('unhandledRejection', (reason) => { logError('unhandledRejection', reason); });

function main(): void {
  log('='.repeat(60));
  log('Claude WSL Chrome Bridge - Bridge Server');
  log('Version: 1.0.0');
  log(`WSL Port: ${WSL_PORT} (accepts WSL relay connections)`);
  log(`Handler Port: ${HANDLER_PORT} (accepts native-host handlers)`);
  log(`Debug: ${DEBUG}`);
  log('='.repeat(60));

  setupWslServer();
  setupHandlerServer();

  log('Bridge server ready. Waiting for connections...');
  log('');
  log('Usage:');
  log('  1. Keep this running');
  log('  2. On WSL, run: ./scripts/claude-chrome.sh');
  log('  3. Open Chrome - extension will connect automatically');
}

main();
