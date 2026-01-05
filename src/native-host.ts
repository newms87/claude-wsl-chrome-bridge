/**
 * Native Messaging Host - Bridges Chrome to WSL Claude
 *
 * This process:
 * 1. Is spawned by Chrome as a Native Messaging host (stdio protocol)
 * 2. Listens on TCP:9333 for WSL relay connections
 * 3. Bridges messages bidirectionally between Chrome and WSL
 *
 * Architecture:
 *   Chrome ↔ native-host (this) ↔ TCP:9333 ↔ WSL Relay ↔ Claude
 *
 * This is a PERSISTENT process - Chrome keeps it alive as long as we
 * respond to ping/get_status messages.
 *
 * IMPORTANT: All logging must go to stderr - stdout is reserved for Native Messaging
 */

import * as net from 'net';
import {
  MessageDecoder,
  RawMessageAccumulator,
  encodeMessage,
  LENGTH_PREFIX_SIZE,
} from './protocol.js';

// Configuration
const WSL_PORT = parseInt(process.env.CLAUDE_BRIDGE_PORT || '9333', 10);
const DEBUG = process.env.CLAUDE_BRIDGE_DEBUG === '1';

// State
let wslServer: net.Server | null = null;
let wslClient: net.Socket | null = null;
const chromeDecoder = new MessageDecoder();
const wslAccumulator = new RawMessageAccumulator();
let shuttingDown = false;

// Queue for messages received from Chrome before WSL is connected
const pendingForWsl: Buffer[] = [];

function log(message: string): void {
  const timestamp = new Date().toISOString();
  process.stderr.write(`[native-host] ${timestamp} ${message}\n`);
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
 * Send message to Chrome via stdout (Native Messaging protocol)
 */
function sendToChrome(message: unknown): void {
  try {
    const encoded = encodeMessage(message);
    debug(`Sending to Chrome: ${JSON.stringify(message).slice(0, 200)}`);
    process.stdout.write(encoded);
  } catch (err) {
    logError('sendToChrome', err);
  }
}

/**
 * Forward a framed message to WSL relay
 */
function forwardToWsl(frame: Buffer): void {
  if (wslClient && !wslClient.destroyed) {
    debug(`Forwarding to WSL: ${frame.length} bytes`);
    wslClient.write(frame);
  } else {
    log(`WSL not connected yet, queuing message (${pendingForWsl.length + 1} pending)`);
    pendingForWsl.push(frame);
  }
}

/**
 * Flush pending messages to WSL when it connects
 */
function flushPendingToWsl(): void {
  if (pendingForWsl.length > 0 && wslClient && !wslClient.destroyed) {
    log(`Flushing ${pendingForWsl.length} pending messages to WSL`);
    while (pendingForWsl.length > 0) {
      const frame = pendingForWsl.shift()!;
      wslClient.write(frame);
    }
  }
}

/**
 * Handle message received from Chrome extension via Native Messaging
 */
function handleChromeMessage(message: unknown): void {
  const msg = message as { type?: string; [key: string]: unknown };
  log(`Received from Chrome: ${JSON.stringify(msg).slice(0, 200)}`);

  // Handle Chrome's native messaging protocol messages locally
  if (msg.type === 'ping') {
    log('Responding to ping with pong');
    sendToChrome({ type: 'pong' });
    return;
  }

  if (msg.type === 'get_status') {
    log('Responding to get_status');
    sendToChrome({
      type: 'status',
      connected: wslClient !== null && !wslClient.destroyed,
      version: '1.0.0',
    });
    return;
  }

  // Forward all other messages to WSL (and ultimately to Claude's native host)
  try {
    const encoded = encodeMessage(message);
    forwardToWsl(encoded);
  } catch (err) {
    logError('forward to WSL', err);
  }
}

/**
 * Setup stdin to receive Native Messaging from Chrome
 */
function setupChromeStdin(): void {
  log('Setting up Chrome stdin listener...');

  process.stdin.on('data', (chunk: Buffer) => {
    log(`Received ${chunk.length} bytes from Chrome stdin`);
    debug(`Raw data (hex): ${chunk.toString('hex').slice(0, 100)}`);
    try {
      const messages = chromeDecoder.decode(chunk);
      log(`Decoded ${messages.length} message(s) from Chrome`);
      for (const msg of messages) {
        handleChromeMessage(msg);
      }
    } catch (err) {
      logError('Chrome stdin decode', err);
    }
  });

  process.stdin.on('end', () => {
    log('Chrome closed connection (stdin ended)');
    cleanup();
  });

  process.stdin.on('error', (err) => {
    logError('Chrome stdin', err);
    cleanup();
  });

  process.stdin.on('close', () => {
    log('Chrome stdin closed');
    cleanup();
  });
}

/**
 * Setup TCP server for WSL relay connections
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

    // Flush any pending messages from Chrome
    flushPendingToWsl();

    // Handle incoming data from WSL
    socket.on('data', (chunk: Buffer) => {
      try {
        const frames = wslAccumulator.accumulate(chunk);
        for (const frame of frames) {
          // Parse the message
          const length = frame.readUInt32LE(0);
          const payload = frame.subarray(LENGTH_PREFIX_SIZE, LENGTH_PREFIX_SIZE + length);

          try {
            const message = JSON.parse(payload.toString('utf-8'));

            // Check for internal bridge messages
            if (message?.type === 'bridge-ready') {
              debug('Received bridge-ready from WSL (ignoring)');
              continue;
            }

            // Forward to Chrome
            log(`Message from WSL (${frame.length} bytes): ${payload.toString('utf-8').slice(0, 300)}`);
            sendToChrome(message);
          } catch {
            // Not valid JSON, still try to forward
            logError('WSL message parse', 'Invalid JSON, dropping message');
          }
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
      port: WSL_PORT,
    });
    socket.write(welcome);
  });

  wslServer.on('error', (err) => {
    logError('WSL server', err);
    const errWithCode = err as NodeJS.ErrnoException;
    if (errWithCode.code === 'EADDRINUSE') {
      log(`FATAL: Port ${WSL_PORT} already in use`);
      sendToChrome({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: `Port ${WSL_PORT} already in use. Is another native-host running?`,
        },
      });
      cleanup();
    }
  });

  wslServer.listen(WSL_PORT, '0.0.0.0', () => {
    log(`WSL server listening on 0.0.0.0:${WSL_PORT}`);
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

  if (wslServer) {
    try { wslServer.close(); } catch { /* ignore */ }
    wslServer = null;
  }

  setTimeout(() => process.exit(0), 100);
}

process.on('SIGINT', () => { log('Received SIGINT'); cleanup(); });
process.on('SIGTERM', () => { log('Received SIGTERM'); cleanup(); });
process.on('SIGHUP', () => { log('Received SIGHUP'); cleanup(); });
process.on('uncaughtException', (err) => { logError('uncaughtException', err); cleanup(); });
process.on('unhandledRejection', (reason) => { logError('unhandledRejection', reason); });

function main(): void {
  log('='.repeat(60));
  log('Claude WSL Chrome Bridge - Native Host');
  log('Version: 1.0.0');
  log(`WSL Port: ${WSL_PORT}`);
  log(`Debug: ${DEBUG}`);
  log('='.repeat(60));

  // Parse command line args (Chrome passes extension origin as first arg)
  const args = process.argv.slice(2);
  if (args.length > 0) {
    log(`Chrome extension origin: ${args[0]}`);
  }

  setupChromeStdin();
  setupWslServer();

  log('Native host ready. Waiting for connections...');
}

main();
