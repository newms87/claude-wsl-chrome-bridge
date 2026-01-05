/**
 * Test script to directly test Chrome extension communication
 *
 * This script acts as a fake "bridge server" that directly communicates
 * with the Chrome extension via native messaging to test if the protocol works.
 *
 * Run on Windows:
 *   node test-chrome-direct.js
 *
 * Then click the Chrome extension to trigger a connection.
 */

import * as net from 'net';

const HANDLER_PORT = 9334;

// Native messaging helpers
function encodeMessage(obj) {
  const json = JSON.stringify(obj);
  const buffer = Buffer.alloc(4 + Buffer.byteLength(json, 'utf-8'));
  buffer.writeUInt32LE(Buffer.byteLength(json, 'utf-8'), 0);
  buffer.write(json, 4, 'utf-8');
  return buffer;
}

function decodeMessages(buffer, state = { pending: Buffer.alloc(0) }) {
  const messages = [];
  let data = Buffer.concat([state.pending, buffer]);

  while (data.length >= 4) {
    const length = data.readUInt32LE(0);
    if (data.length < 4 + length) break;

    const json = data.subarray(4, 4 + length).toString('utf-8');
    try {
      messages.push(JSON.parse(json));
    } catch (e) {
      console.log('Failed to parse:', json);
    }
    data = data.subarray(4 + length);
  }

  state.pending = data;
  return messages;
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// Start a simple server that simulates being the bridge server
const server = net.createServer((socket) => {
  log('Chrome handler connected!');
  const state = { pending: Buffer.alloc(0) };

  // Send a test message immediately - this simulates what Claude would send
  // This is a simplified version of what tabs_context_mcp might look like
  const testRequest = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "tabs_context_mcp",
      arguments: {}
    }
  };

  log('Sending test request to Chrome: ' + JSON.stringify(testRequest));
  socket.write(encodeMessage(testRequest));

  // Also try sending a screenshot request after 2 seconds
  setTimeout(() => {
    const screenshotRequest = {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "screenshot",
        arguments: {}
      }
    };
    log('Sending screenshot request to Chrome: ' + JSON.stringify(screenshotRequest));
    socket.write(encodeMessage(screenshotRequest));
  }, 2000);

  // Send keep-alive pings every 3 seconds
  const keepAliveInterval = setInterval(() => {
    if (socket.destroyed) {
      clearInterval(keepAliveInterval);
      return;
    }
    const ping = { type: "ping", timestamp: Date.now() };
    log('Sending keep-alive ping');
    socket.write(encodeMessage(ping));
  }, 3000);

  socket.on('data', (chunk) => {
    const messages = decodeMessages(chunk, state);
    for (const msg of messages) {
      log('Received from Chrome: ' + JSON.stringify(msg).slice(0, 500));
    }
  });

  socket.on('close', () => {
    log('Chrome handler disconnected');
    clearInterval(keepAliveInterval);
  });

  socket.on('error', (err) => {
    log('Socket error: ' + err.message);
    clearInterval(keepAliveInterval);
  });
});

server.listen(HANDLER_PORT, '127.0.0.1', () => {
  log('Test server listening on 127.0.0.1:' + HANDLER_PORT);
  log('');
  log('Now click the Chrome Claude extension to trigger a connection.');
  log('Watch for messages from Chrome...');
  log('');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    log('ERROR: Port ' + HANDLER_PORT + ' already in use. Stop bridge-server first.');
  } else {
    log('Server error: ' + err.message);
  }
  process.exit(1);
});
