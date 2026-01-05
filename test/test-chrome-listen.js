/**
 * Test script that LISTENS for Chrome to send the first message
 *
 * Native messaging typically has Chrome initiate the conversation.
 * This test waits to see what Chrome sends first.
 *
 * Run on Windows:
 *   node test-chrome-listen.js
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

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

const server = net.createServer((socket) => {
  log('Chrome handler connected!');
  log('Waiting for Chrome to send the first message...');
  log('');

  let buffer = Buffer.alloc(0);

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    log(`Received ${chunk.length} bytes (total buffer: ${buffer.length} bytes)`);

    // Try to parse native messaging frames
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      log(`Frame length: ${length}`);

      if (buffer.length < 4 + length) {
        log(`Waiting for more data (have ${buffer.length}, need ${4 + length})`);
        break;
      }

      const json = buffer.subarray(4, 4 + length).toString('utf-8');
      buffer = buffer.subarray(4 + length);

      log('');
      log('=== MESSAGE FROM CHROME ===');
      try {
        const msg = JSON.parse(json);
        log(JSON.stringify(msg, null, 2));

        // Respond to ping with pong
        if (msg.type === 'ping') {
          log('');
          log('Received PING - sending PONG...');
          const pong = { type: "pong" };
          socket.write(encodeMessage(pong));
          log('PONG sent!');
        } else if (msg.type === 'get_status') {
          log('');
          log('Received GET_STATUS - sending status...');
          const status = {
            type: "status",
            connected: true,
            version: "1.0.0"
          };
          socket.write(encodeMessage(status));
          log('Status sent: ' + JSON.stringify(status));
        } else if (msg.method || msg.type) {
          log('');
          log('Unknown message type, sending generic response...');
          const response = {
            jsonrpc: "2.0",
            id: msg.id || 1,
            result: { status: "ok", message: "Received your message" }
          };
          socket.write(encodeMessage(response));
          log('Response sent: ' + JSON.stringify(response));
        }
      } catch (e) {
        log('Raw JSON: ' + json);
        log('Parse error: ' + e.message);
      }
      log('===========================');
      log('');
    }
  });

  socket.on('close', () => {
    log('Chrome handler disconnected');
    log('');
    log('Summary: Did Chrome send any messages? Check output above.');
  });

  socket.on('error', (err) => {
    log('Socket error: ' + err.message);
  });
});

server.listen(HANDLER_PORT, '127.0.0.1', () => {
  log('Test server listening on 127.0.0.1:' + HANDLER_PORT);
  log('');
  log('This test waits for Chrome to send the FIRST message.');
  log('Click the Chrome Claude extension to trigger a connection.');
  log('');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    log('ERROR: Port ' + HANDLER_PORT + ' already in use.');
  } else {
    log('Server error: ' + err.message);
  }
  process.exit(1);
});
