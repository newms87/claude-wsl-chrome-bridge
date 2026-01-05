/**
 * WSL Relay - Bridges Windows native-host to Claude's chrome-native-host
 *
 * Architecture:
 *   Chrome ↔ Windows native-host ↔ TCP:9333 ↔ WSL relay (this) ↔ Claude's chrome-native-host
 *
 * This runs in WSL, started by the claude-chrome wrapper script.
 * It connects to Windows over TCP and spawns Claude's native host locally.
 */

import * as net from 'net';
import { spawn, ChildProcess, execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { RawMessageAccumulator, LENGTH_PREFIX_SIZE } from './protocol.js';
import {
  createLogger,
  createLifecycle,
  sleep,
  VERSION,
  DEFAULT_BRIDGE_PORT,
} from './shared/index.js';

// Configuration from environment
const TCP_PORT = parseInt(process.env.CLAUDE_BRIDGE_PORT || String(DEFAULT_BRIDGE_PORT), 10);
const DEBUG = process.env.CLAUDE_BRIDGE_DEBUG === '1';

// Connection retry settings
const MAX_RETRIES = 30;
const RETRY_DELAY_MS = 2000;
const CONNECTION_TIMEOUT_MS = 5000;

// Initialize logger and lifecycle manager
const logger = createLogger('wsl-relay', DEBUG);
const lifecycle = createLifecycle(logger);

// Connection state
let tcpSocket: net.Socket | null = null;
let claudeProcess: ChildProcess | null = null;
const tcpAccumulator = new RawMessageAccumulator();
const claudeAccumulator = new RawMessageAccumulator();

// Register cleanup handlers
lifecycle.onCleanup(() => {
  if (claudeProcess) {
    claudeProcess.kill();
    claudeProcess = null;
  }
});
lifecycle.onCleanup(() => {
  if (tcpSocket) {
    tcpSocket.destroy();
    tcpSocket = null;
  }
});

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

const TCP_HOST = getWindowsHostIP();
const CLAUDE_NATIVE_HOST = process.env.CLAUDE_NATIVE_HOST || findClaudeNativeHost();

/**
 * Send a framed message to TCP (to Windows bridge)
 */
function sendToTcp(frame: Buffer): void {
  if (tcpSocket && !tcpSocket.destroyed) {
    logger.debug(`Sending to TCP: ${frame.length} bytes`);
    tcpSocket.write(frame);
  } else {
    logger.log('WARNING: TCP not connected, dropping message');
  }
}

/**
 * Send a framed message to Claude's native host
 */
function sendToClaude(frame: Buffer): void {
  if (claudeProcess?.stdin && !claudeProcess.stdin.destroyed) {
    logger.debug(`Sending to Claude: ${frame.length} bytes`);
    claudeProcess.stdin.write(frame);
  } else {
    logger.log('WARNING: Claude process not available, dropping message');
  }
}

/**
 * Connect to Windows native host with retry logic
 */
async function connectWithRetry(): Promise<net.Socket> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      logger.log(`Retry attempt ${attempt + 1}/${MAX_RETRIES} in ${RETRY_DELAY_MS}ms...`);
      await sleep(RETRY_DELAY_MS);
    }
    logger.log(`Connecting to Windows bridge at ${TCP_HOST}:${TCP_PORT}...`);

    try {
      const socket = await new Promise<net.Socket>((resolve, reject) => {
        const s = net.createConnection({ port: TCP_PORT, host: TCP_HOST }, () => {
          resolve(s);
        });

        s.once('error', reject);

        const timeout = setTimeout(() => {
          s.destroy();
          reject(new Error(`Connection timeout after ${CONNECTION_TIMEOUT_MS}ms`));
        }, CONNECTION_TIMEOUT_MS);

        s.once('connect', () => {
          clearTimeout(timeout);
        });
      });

      return socket;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      logger.log(`Connection attempt ${attempt + 1} failed: ${lastError.message}`);
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
  logger.log(`Spawning Claude native host: ${CLAUDE_NATIVE_HOST}`);

  const proc = spawn(CLAUDE_NATIVE_HOST, [], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });

  proc.on('error', (err) => {
    logger.error('Claude process spawn', err);
    lifecycle.shutdown();
  });

  proc.on('exit', (code, signal) => {
    logger.log(`Claude process exited: code=${code}, signal=${signal}`);
    if (!lifecycle.isShuttingDown()) {
      lifecycle.shutdown();
    }
  });

  proc.stdout?.on('data', (chunk: Buffer) => {
    logger.debug(`Claude stdout: ${chunk.length} bytes`);
    try {
      const frames = claudeAccumulator.accumulate(chunk);
      for (const frame of frames) {
        sendToTcp(frame);
      }
    } catch (err) {
      logger.error('Claude stdout processing', err);
    }
  });

  return proc;
}

/**
 * Setup TCP socket handlers
 */
function setupTcpSocket(socket: net.Socket): void {
  tcpSocket = socket;
  tcpAccumulator.reset();

  socket.on('data', (chunk: Buffer) => {
    logger.debug(`TCP data: ${chunk.length} bytes`);
    try {
      const frames = tcpAccumulator.accumulate(chunk);
      for (const frame of frames) {
        const length = frame.readUInt32LE(0);
        const payload = frame.subarray(LENGTH_PREFIX_SIZE, LENGTH_PREFIX_SIZE + length);

        try {
          const message = JSON.parse(payload.toString('utf-8'));
          if (message?.type === 'bridge-ready') {
            logger.log(`Bridge ready (v${message.version || 'unknown'})`);
            continue;
          }
        } catch {
          // Not JSON or parse error, forward anyway
        }

        sendToClaude(frame);
      }
    } catch (err) {
      logger.error('TCP data processing', err);
    }
  });

  socket.on('close', () => {
    logger.log('TCP connection closed');
    if (!lifecycle.isShuttingDown()) {
      lifecycle.shutdown();
    }
  });

  socket.on('error', (err) => {
    logger.error('TCP socket', err);
  });
}

function printConnectionHelp(): void {
  process.stderr.write(`
================================================================================
ERROR: Failed to connect to Windows Native Host

The WSL relay could not connect to native-host on Windows at ${TCP_HOST}:${TCP_PORT}

To fix:
1. Make sure Chrome is open with the Claude extension active
   (The extension spawns native-host.js automatically)

2. Make sure Windows Firewall allows the connection on port ${TCP_PORT}

3. If using WSL2, ensure networking is working:
   wsl --shutdown  (then restart WSL)

4. Try manually starting the native host:
   node "C:\\Users\\<you>\\AppData\\Local\\ClaudeWSLBridge\\native-host.js"

================================================================================
`);
}

async function main(): Promise<void> {
  logger.log('='.repeat(60));
  logger.log('Claude WSL Chrome Bridge - WSL Relay');
  logger.log(`Version: ${VERSION}`);
  logger.log(`Windows bridge: ${TCP_HOST}:${TCP_PORT}`);
  logger.log(`Claude native host: ${CLAUDE_NATIVE_HOST}`);
  logger.log(`Debug: ${DEBUG}`);
  logger.log('='.repeat(60));

  try {
    const socket = await connectWithRetry();
    logger.log('Connected to Windows bridge');

    setupTcpSocket(socket);

    claudeProcess = spawnClaudeNativeHost();
    logger.log('Claude native host spawned');

    logger.log('Relay ready - bridging Chrome ↔ Claude');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.log(`FATAL: ${msg}`);
    printConnectionHelp();
    process.exit(1);
  }
}

main();
