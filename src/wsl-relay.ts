/**
 * WSL Relay - Bridges Windows Chrome Bridge to Claude's native host
 *
 * This process:
 * 1. Connects to the Windows native-host via TCP
 * 2. Spawns Claude's chrome-native-host process
 * 3. Forwards messages bidirectionally between TCP and Claude's native host
 *
 * Flow:
 *   Chrome ↔ Windows native-host ↔ TCP ↔ WSL relay ↔ Claude's native-host
 */

import * as net from 'net';
import { spawn, ChildProcess, execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  RawMessageAccumulator,
  encodeMessage,
  LENGTH_PREFIX_SIZE,
} from './protocol.js';

/**
 * Auto-detect Windows host IP from WSL2 gateway
 */
function getWindowsHostIP(): string {
  if (process.env.CLAUDE_BRIDGE_HOST) {
    return process.env.CLAUDE_BRIDGE_HOST;
  }

  try {
    const route = execSync('ip route show default', { encoding: 'utf-8' });
    const match = route.match(/via\s+(\d+\.\d+\.\d+\.\d+)/);
    if (match) {
      return match[1];
    }
  } catch {
    // Ignore errors
  }

  return '127.0.0.1';
}

/**
 * Find Claude's chrome native host script
 */
function findClaudeNativeHost(): string {
  const defaultPath = path.join(
    process.env.HOME || '/home',
    '.claude',
    'chrome',
    'chrome-native-host'
  );

  if (fs.existsSync(defaultPath)) {
    return defaultPath;
  }

  throw new Error(
    `Claude's chrome-native-host not found at ${defaultPath}. ` +
      'Make sure Claude Code is installed and has chrome integration enabled.'
  );
}

// Configuration
const TCP_PORT = parseInt(process.env.CLAUDE_BRIDGE_PORT || '9333', 10);
const TCP_HOST = getWindowsHostIP();
const DEBUG = process.env.CLAUDE_BRIDGE_DEBUG === '1';
const CLAUDE_NATIVE_HOST = process.env.CLAUDE_NATIVE_HOST || findClaudeNativeHost();

// Retry configuration - more persistent to allow time for Chrome to spawn native-host
const MAX_RETRIES = 30;
const RETRY_DELAY_MS = 2000;
const CONNECTION_TIMEOUT = 5000;

// State
let tcpSocket: net.Socket | null = null;
let claudeProcess: ChildProcess | null = null;
let isConnected = false;
let shuttingDown = false;
const tcpAccumulator = new RawMessageAccumulator();
const claudeAccumulator = new RawMessageAccumulator();

function log(message: string): void {
  const timestamp = new Date().toISOString();
  process.stderr.write(`[wsl-relay] ${timestamp} ${message}\n`);
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Send a framed message to TCP (to Windows bridge)
 */
function sendToTcp(frame: Buffer): void {
  if (tcpSocket && !tcpSocket.destroyed) {
    debug(`Sending to TCP: ${frame.length} bytes`);
    tcpSocket.write(frame);
  } else {
    log('WARNING: TCP not connected, dropping message');
  }
}

/**
 * Send a framed message to Claude's native host
 */
function sendToClaude(frame: Buffer): void {
  if (claudeProcess && claudeProcess.stdin && !claudeProcess.stdin.destroyed) {
    debug(`Sending to Claude: ${frame.length} bytes`);
    claudeProcess.stdin.write(frame);
  } else {
    log('WARNING: Claude process not available, dropping message');
  }
}

/**
 * Connect to Windows native host with retry logic
 */
async function connectWithRetry(): Promise<net.Socket> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      log(`Retry attempt ${attempt + 1}/${MAX_RETRIES} in ${RETRY_DELAY_MS}ms...`);
      await sleep(RETRY_DELAY_MS);
    }
    log(`Connecting to Windows bridge at ${TCP_HOST}:${TCP_PORT}...`);

    try {
      const socket = await new Promise<net.Socket>((resolve, reject) => {
        const s = net.createConnection({ port: TCP_PORT, host: TCP_HOST }, () => {
          resolve(s);
        });

        s.once('error', reject);

        const timeout = setTimeout(() => {
          s.destroy();
          reject(new Error(`Connection timeout after ${CONNECTION_TIMEOUT}ms`));
        }, CONNECTION_TIMEOUT);

        s.once('connect', () => {
          clearTimeout(timeout);
        });
      });

      return socket;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      log(`Connection attempt ${attempt + 1} failed: ${lastError.message}`);
    }
  }

  throw new Error(
    `Failed to connect to Windows bridge after ${MAX_RETRIES} attempts: ${lastError?.message}`
  );
}

/**
 * Spawn Claude's chrome native host process
 */
function spawnClaudeNativeHost(): ChildProcess {
  log(`Spawning Claude native host: ${CLAUDE_NATIVE_HOST}`);

  const proc = spawn(CLAUDE_NATIVE_HOST, [], {
    stdio: ['pipe', 'pipe', 'inherit'], // stdin, stdout piped; stderr inherited
  });

  proc.on('error', (err) => {
    logError('Claude process spawn', err);
    cleanup();
  });

  proc.on('exit', (code, signal) => {
    log(`Claude process exited: code=${code}, signal=${signal}`);
    if (!shuttingDown) {
      cleanup();
    }
  });

  // Forward Claude's stdout to TCP
  proc.stdout?.on('data', (chunk: Buffer) => {
    debug(`Claude stdout: ${chunk.length} bytes`);
    try {
      const frames = claudeAccumulator.accumulate(chunk);
      for (const frame of frames) {
        sendToTcp(frame);
      }
    } catch (err) {
      logError('Claude stdout processing', err);
    }
  });

  return proc;
}

/**
 * Setup TCP socket handlers
 */
function setupTcpSocket(socket: net.Socket): void {
  tcpSocket = socket;
  isConnected = true;
  tcpAccumulator.reset();

  socket.on('data', (chunk: Buffer) => {
    debug(`TCP data: ${chunk.length} bytes`);
    try {
      const frames = tcpAccumulator.accumulate(chunk);
      for (const frame of frames) {
        // Parse to check for bridge-ready
        const length = frame.readUInt32LE(0);
        const payload = frame.subarray(LENGTH_PREFIX_SIZE, LENGTH_PREFIX_SIZE + length);

        try {
          const message = JSON.parse(payload.toString('utf-8'));
          if (message?.type === 'bridge-ready') {
            log(`Bridge ready (v${message.version || 'unknown'})`);
            continue; // Don't forward internal messages
          }
        } catch {
          // Not JSON or parse error, forward anyway
        }

        // Forward to Claude's native host
        sendToClaude(frame);
      }
    } catch (err) {
      logError('TCP data processing', err);
    }
  });

  socket.on('close', () => {
    log('TCP connection closed');
    isConnected = false;
    if (!shuttingDown) {
      cleanup();
    }
  });

  socket.on('error', (err) => {
    logError('TCP socket', err);
    isConnected = false;
  });
}

function cleanup(): void {
  if (shuttingDown) return;
  shuttingDown = true;

  log('Cleaning up...');

  if (claudeProcess) {
    try {
      claudeProcess.kill();
    } catch {
      // Ignore
    }
    claudeProcess = null;
  }

  if (tcpSocket) {
    try {
      tcpSocket.destroy();
    } catch {
      // Ignore
    }
    tcpSocket = null;
  }

  setTimeout(() => {
    process.exit(0);
  }, 100);
}

function printConnectionHelp(): void {
  process.stderr.write(`
================================================================================
ERROR: Failed to connect to Windows Chrome Bridge

The WSL relay could not connect to native-host on Windows at ${TCP_HOST}:${TCP_PORT}

To fix:
1. On Windows, start the bridge:
   node "C:\\Users\\<you>\\AppData\\Local\\ClaudeWSLBridge\\native-host.js"

2. Make sure Windows Firewall allows the connection

3. If using WSL2, ensure networking is working:
   wsl --shutdown  (then restart WSL)

================================================================================
`);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
process.on('SIGHUP', cleanup);
process.on('uncaughtException', (err) => {
  logError('uncaughtException', err);
  cleanup();
});

async function main(): Promise<void> {
  log('='.repeat(60));
  log('Claude WSL Chrome Bridge - WSL Relay');
  log(`Version: 1.0.0`);
  log(`Windows bridge: ${TCP_HOST}:${TCP_PORT}`);
  log(`Claude native host: ${CLAUDE_NATIVE_HOST}`);
  log(`Debug: ${DEBUG}`);
  log('='.repeat(60));

  try {
    // Connect to Windows bridge first
    const socket = await connectWithRetry();
    log('Connected to Windows bridge');

    setupTcpSocket(socket);

    // Spawn Claude's native host
    claudeProcess = spawnClaudeNativeHost();
    log('Claude native host spawned');

    log('Relay ready - bridging Chrome ↔ Claude');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`FATAL: ${msg}`);
    printConnectionHelp();
    process.exit(1);
  }
}

main();
