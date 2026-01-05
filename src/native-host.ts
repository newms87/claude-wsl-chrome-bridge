/**
 * Native Messaging Handler - Bridges Chrome to Bridge Server
 *
 * This process:
 * 1. Is spawned by Chrome as a Native Messaging host (stdio protocol)
 * 2. Connects to the Bridge Server on localhost:9334
 * 3. Bridges messages bidirectionally between Chrome and Bridge Server
 *
 * This is a short-lived process - Chrome may spawn and close it multiple times.
 * The Bridge Server maintains persistent connections.
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
const BRIDGE_PORT = parseInt(process.env.CLAUDE_BRIDGE_HANDLER_PORT || '9334', 10);
const BRIDGE_HOST = '127.0.0.1';
const DEBUG = process.env.CLAUDE_BRIDGE_DEBUG === '1';
const CONNECT_TIMEOUT = 2000;

// State
let bridgeSocket: net.Socket | null = null;
const chromeDecoder = new MessageDecoder();
const bridgeAccumulator = new RawMessageAccumulator();
let shuttingDown = false;
let bridgeConnected = false;

// Queue for messages received before bridge is connected
const pendingForBridge: Buffer[] = [];

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
 * Forward a framed message to the bridge server
 */
function forwardToBridge(frame: Buffer): void {
  if (bridgeSocket && !bridgeSocket.destroyed && bridgeConnected) {
    debug(`Forwarding to bridge: ${frame.length} bytes`);
    bridgeSocket.write(frame);
  } else {
    log(`Bridge not connected yet, queuing message (${pendingForBridge.length + 1} pending)`);
    pendingForBridge.push(frame);
  }
}

/**
 * Flush pending messages to bridge when it connects
 */
function flushPendingToBridge(): void {
  if (pendingForBridge.length > 0 && bridgeSocket && !bridgeSocket.destroyed && bridgeConnected) {
    log(`Flushing ${pendingForBridge.length} pending messages to bridge`);
    while (pendingForBridge.length > 0) {
      const frame = pendingForBridge.shift()!;
      bridgeSocket.write(frame);
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
      connected: bridgeConnected,
      version: '1.0.0',
    });
    return;
  }

  // Forward all other messages to bridge (and ultimately to Claude's native host)
  try {
    const encoded = encodeMessage(message);
    forwardToBridge(encoded);
  } catch (err) {
    logError('forward to bridge', err);
  }
}

/**
 * Setup stdin to receive Native Messaging from Chrome
 */
function setupChromeStdin(): void {
  log('Setting up Chrome stdin listener...');

  process.stdin.on('data', (chunk: Buffer) => {
    log(`Received ${chunk.length} bytes from Chrome stdin`);
    log(`Raw data (hex): ${chunk.toString('hex').slice(0, 100)}`);
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
 * Connect to the bridge server
 */
function connectToBridge(): void {
  log(`Connecting to bridge server at ${BRIDGE_HOST}:${BRIDGE_PORT}...`);

  bridgeSocket = net.createConnection({ port: BRIDGE_PORT, host: BRIDGE_HOST });

  const timeout = setTimeout(() => {
    if (!bridgeConnected) {
      log('Connection to bridge server timed out');
      sendToChrome({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: 'Bridge server connection timeout. Is bridge-server.js running?',
        },
      });
      cleanup();
    }
  }, CONNECT_TIMEOUT);

  bridgeSocket.on('connect', () => {
    clearTimeout(timeout);
    bridgeConnected = true;
    log('Connected to bridge server');
    flushPendingToBridge();
  });

  bridgeSocket.on('data', (chunk: Buffer) => {
    try {
      const frames = bridgeAccumulator.accumulate(chunk);
      for (const frame of frames) {
        // Parse the message
        const length = frame.readUInt32LE(0);
        const payload = frame.subarray(LENGTH_PREFIX_SIZE, LENGTH_PREFIX_SIZE + length);
        const message = JSON.parse(payload.toString('utf-8'));

        // Check for internal messages
        if (message?.type === 'handler-ready') {
          debug(`Bridge says handler ready, WSL connected: ${message.wslConnected}`);
          continue;
        }

        // Forward to Chrome
        sendToChrome(message);
      }
    } catch (err) {
      logError('Bridge data processing', err);
    }
  });

  bridgeSocket.on('close', () => {
    log('Bridge connection closed');
    bridgeConnected = false;
    // Don't cleanup - let Chrome stdin closing trigger cleanup
  });

  bridgeSocket.on('error', (err) => {
    clearTimeout(timeout);
    logError('Bridge socket', err);
    bridgeConnected = false;

    const errWithCode = err as NodeJS.ErrnoException;
    if (errWithCode.code === 'ECONNREFUSED') {
      sendToChrome({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: 'Bridge server not running. Please start bridge-server.js first.',
        },
      });
    }
  });
}

function cleanup(): void {
  if (shuttingDown) return;
  shuttingDown = true;

  log('Cleaning up...');

  if (bridgeSocket) {
    try { bridgeSocket.destroy(); } catch { /* ignore */ }
    bridgeSocket = null;
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
  log('Claude WSL Chrome Bridge - Native Host Handler');
  log('Version: 1.0.0');
  log(`Bridge Server: ${BRIDGE_HOST}:${BRIDGE_PORT}`);
  log(`Debug: ${DEBUG}`);
  log('='.repeat(60));

  // Parse command line args (Chrome passes extension origin as first arg)
  const args = process.argv.slice(2);
  if (args.length > 0) {
    log(`Chrome extension origin: ${args[0]}`);
  }

  setupChromeStdin();
  connectToBridge();
}

main();
