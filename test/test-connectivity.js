/**
 * Connectivity Test Script
 *
 * This script tests the TCP connection between WSL and the Windows native-host.
 * Run the native-host on Windows first, then run this script in WSL.
 *
 * Usage: node test/test-connectivity.js
 */

import * as net from 'net';
import * as readline from 'readline';

const TCP_PORT = parseInt(process.env.CLAUDE_BRIDGE_PORT || '9333', 10);
const TCP_HOST = process.env.CLAUDE_BRIDGE_HOST || '127.0.0.1';

// Colors for terminal output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
};

function log(color, prefix, message) {
  console.log(`${color}[${prefix}]${colors.reset} ${message}`);
}

function success(msg) { log(colors.green, '✓', msg); }
function error(msg) { log(colors.red, '✗', msg); }
function info(msg) { log(colors.cyan, '*', msg); }
function warn(msg) { log(colors.yellow, '!', msg); }
function recv(msg) { log(colors.magenta, '←', msg); }
function send(msg) { log(colors.cyan, '→', msg); }

/**
 * Encode message with 4-byte little-endian length prefix
 */
function encodeMessage(obj) {
  const json = JSON.stringify(obj);
  const payload = Buffer.from(json, 'utf-8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

/**
 * Decode messages from buffer (handles partial reads)
 */
class MessageDecoder {
  constructor() {
    this.buffer = Buffer.alloc(0);
  }

  decode(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages = [];

    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (this.buffer.length < 4 + length) break;

      const payload = this.buffer.subarray(4, 4 + length);
      messages.push(JSON.parse(payload.toString('utf-8')));
      this.buffer = this.buffer.subarray(4 + length);
    }

    return messages;
  }
}

console.log('');
console.log('='.repeat(60));
console.log('  Claude WSL Chrome Bridge - Connectivity Test');
console.log('='.repeat(60));
console.log('');

info(`Connecting to ${TCP_HOST}:${TCP_PORT}...`);

const decoder = new MessageDecoder();
let messageCount = 0;

const client = net.createConnection({ port: TCP_PORT, host: TCP_HOST }, () => {
  success(`Connected to Windows bridge at ${TCP_HOST}:${TCP_PORT}`);
  console.log('');
  info('You can now type JSON messages to send to the bridge.');
  info('The bridge will forward them to Chrome and return responses.');
  info('Type "quit" or press Ctrl+C to exit.');
  console.log('');
  info('Example messages to try:');
  console.log('  {"type":"ping","id":1}');
  console.log('  {"jsonrpc":"2.0","method":"test","id":2}');
  console.log('');

  // Setup readline for interactive input
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'msg> '
  });

  rl.prompt();

  rl.on('line', (line) => {
    const trimmed = line.trim();

    if (trimmed === 'quit' || trimmed === 'exit') {
      info('Closing connection...');
      client.end();
      rl.close();
      return;
    }

    if (!trimmed) {
      rl.prompt();
      return;
    }

    try {
      const obj = JSON.parse(trimmed);
      const encoded = encodeMessage(obj);
      send(`Sending: ${JSON.stringify(obj)}`);
      client.write(encoded);
    } catch (err) {
      error(`Invalid JSON: ${err.message}`);
      warn('Please enter valid JSON, e.g.: {"type":"ping"}');
    }

    rl.prompt();
  });

  rl.on('close', () => {
    info('Readline closed');
  });
});

client.on('data', (chunk) => {
  const messages = decoder.decode(chunk);
  for (const msg of messages) {
    messageCount++;
    recv(`Received message #${messageCount}:`);
    console.log(JSON.stringify(msg, null, 2));
    console.log('');
  }
});

client.on('error', (err) => {
  error(`Connection error: ${err.message}`);

  if (err.code === 'ECONNREFUSED') {
    console.log('');
    warn('The Windows bridge is not running.');
    info('Please start the native-host on Windows first:');
    console.log('');
    console.log('  In Windows PowerShell:');
    console.log('  cd <path-to-project>');
    console.log('  node dist/native-host.js');
    console.log('');
  }

  process.exit(1);
});

client.on('close', () => {
  info('Connection closed');
  info(`Total messages received: ${messageCount}`);
  process.exit(0);
});

client.on('timeout', () => {
  error('Connection timeout');
  client.destroy();
  process.exit(1);
});

// Set connection timeout
client.setTimeout(10000);
