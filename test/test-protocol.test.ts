/**
 * Unit tests for protocol module
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  encodeMessage,
  MessageDecoder,
  RawMessageAccumulator,
  LENGTH_PREFIX_SIZE,
  MAX_MESSAGE_SIZE_TO_CHROME,
  extractPayload,
  encodeRawWithPrefix,
} from '../dist/protocol.js';

describe('encodeMessage', () => {
  it('should encode a simple message with correct length prefix', () => {
    const message = { type: 'test', data: 'hello' };
    const encoded = encodeMessage(message);

    // Read length prefix
    const length = encoded.readUInt32LE(0);
    const payload = encoded.subarray(LENGTH_PREFIX_SIZE);

    assert.strictEqual(length, payload.length);
    assert.deepStrictEqual(JSON.parse(payload.toString('utf-8')), message);
  });

  it('should use little-endian byte order', () => {
    const message = { x: 1 };
    const encoded = encodeMessage(message);

    // {"x":1} is 7 bytes
    // Little-endian: 0x07 0x00 0x00 0x00
    assert.strictEqual(encoded[0], 7);
    assert.strictEqual(encoded[1], 0);
    assert.strictEqual(encoded[2], 0);
    assert.strictEqual(encoded[3], 0);
  });

  it('should handle unicode characters correctly', () => {
    const message = { text: 'Hello 世界 😀' };
    const encoded = encodeMessage(message);

    const length = encoded.readUInt32LE(0);
    const payload = encoded.subarray(LENGTH_PREFIX_SIZE);

    // Length should be byte length, not character length
    assert.strictEqual(length, payload.length);
    assert.deepStrictEqual(JSON.parse(payload.toString('utf-8')), message);
  });

  it('should handle empty object', () => {
    const message = {};
    const encoded = encodeMessage(message);

    const length = encoded.readUInt32LE(0);
    assert.strictEqual(length, 2); // "{}" is 2 bytes
  });

  it('should throw on message exceeding size limit', () => {
    const largeData = 'x'.repeat(MAX_MESSAGE_SIZE_TO_CHROME + 1);

    assert.throws(() => encodeMessage({ data: largeData }), /exceeds maximum/);
  });
});

describe('MessageDecoder', () => {
  it('should decode a complete message', () => {
    const decoder = new MessageDecoder();
    const original = { type: 'test', value: 42 };
    const encoded = encodeMessage(original);

    const messages = decoder.decode(encoded);

    assert.strictEqual(messages.length, 1);
    assert.deepStrictEqual(messages[0], original);
  });

  it('should handle partial messages across chunks', () => {
    const decoder = new MessageDecoder();
    const original = { type: 'test', data: 'some data here' };
    const encoded = encodeMessage(original);

    // Split into chunks
    const chunk1 = encoded.subarray(0, 5);
    const chunk2 = encoded.subarray(5, 10);
    const chunk3 = encoded.subarray(10);

    assert.strictEqual(decoder.decode(chunk1).length, 0);
    assert.strictEqual(decoder.decode(chunk2).length, 0);

    const messages = decoder.decode(chunk3);
    assert.strictEqual(messages.length, 1);
    assert.deepStrictEqual(messages[0], original);
  });

  it('should decode multiple messages in one chunk', () => {
    const decoder = new MessageDecoder();
    const msg1 = { id: 1 };
    const msg2 = { id: 2 };
    const msg3 = { id: 3 };

    const combined = Buffer.concat([
      encodeMessage(msg1),
      encodeMessage(msg2),
      encodeMessage(msg3),
    ]);

    const messages = decoder.decode(combined);

    assert.strictEqual(messages.length, 3);
    assert.deepStrictEqual(messages[0], msg1);
    assert.deepStrictEqual(messages[1], msg2);
    assert.deepStrictEqual(messages[2], msg3);
  });

  it('should handle messages split at length prefix boundary', () => {
    const decoder = new MessageDecoder();
    const original = { test: true };
    const encoded = encodeMessage(original);

    // Split exactly at the length prefix boundary
    const chunk1 = encoded.subarray(0, LENGTH_PREFIX_SIZE);
    const chunk2 = encoded.subarray(LENGTH_PREFIX_SIZE);

    assert.strictEqual(decoder.decode(chunk1).length, 0);

    const messages = decoder.decode(chunk2);
    assert.strictEqual(messages.length, 1);
    assert.deepStrictEqual(messages[0], original);
  });

  it('should handle split within length prefix', () => {
    const decoder = new MessageDecoder();
    const original = { data: 'test' };
    const encoded = encodeMessage(original);

    // Split in the middle of length prefix (at byte 2)
    const chunk1 = encoded.subarray(0, 2);
    const chunk2 = encoded.subarray(2);

    assert.strictEqual(decoder.decode(chunk1).length, 0);

    const messages = decoder.decode(chunk2);
    assert.strictEqual(messages.length, 1);
    assert.deepStrictEqual(messages[0], original);
  });

  it('should reset state correctly', () => {
    const decoder = new MessageDecoder();
    const original = { value: 'test' };
    const encoded = encodeMessage(original);

    // Feed partial data
    decoder.decode(encoded.subarray(0, 5));
    assert.ok(decoder.pendingBytes > 0);

    // Reset
    decoder.reset();
    assert.strictEqual(decoder.pendingBytes, 0);

    // Feed complete message
    const messages = decoder.decode(encodeMessage({ fresh: true }));

    assert.strictEqual(messages.length, 1);
    assert.deepStrictEqual(messages[0], { fresh: true });
  });

  it('should throw on invalid JSON', () => {
    const decoder = new MessageDecoder();

    // Create a frame with invalid JSON
    const invalidJson = Buffer.from('not json', 'utf-8');
    const header = Buffer.alloc(4);
    header.writeUInt32LE(invalidJson.length, 0);
    const frame = Buffer.concat([header, invalidJson]);

    assert.throws(() => decoder.decode(frame), /Invalid JSON/);
  });
});

describe('RawMessageAccumulator', () => {
  it('should accumulate and return complete frames', () => {
    const accumulator = new RawMessageAccumulator();
    const msg = { type: 'raw' };
    const encoded = encodeMessage(msg);

    const frames = accumulator.accumulate(encoded);

    assert.strictEqual(frames.length, 1);
    assert.strictEqual(Buffer.compare(frames[0], encoded), 0);
  });

  it('should preserve length prefix in returned frames', () => {
    const accumulator = new RawMessageAccumulator();
    const msg = { preservePrefix: true };
    const encoded = encodeMessage(msg);

    const frames = accumulator.accumulate(encoded);

    // Verify the frame includes the length prefix
    assert.strictEqual(frames[0].length, encoded.length);
    assert.strictEqual(
      frames[0].readUInt32LE(0),
      encoded.length - LENGTH_PREFIX_SIZE
    );
  });

  it('should handle partial frames', () => {
    const accumulator = new RawMessageAccumulator();
    const msg = { data: 'test' };
    const encoded = encodeMessage(msg);

    // Send partial
    const frames1 = accumulator.accumulate(encoded.subarray(0, 5));
    assert.strictEqual(frames1.length, 0);
    assert.ok(accumulator.pendingBytes > 0);

    // Send rest
    const frames2 = accumulator.accumulate(encoded.subarray(5));
    assert.strictEqual(frames2.length, 1);
    assert.strictEqual(Buffer.compare(frames2[0], encoded), 0);
  });

  it('should handle multiple frames in one chunk', () => {
    const accumulator = new RawMessageAccumulator();
    const msg1 = encodeMessage({ id: 1 });
    const msg2 = encodeMessage({ id: 2 });

    const combined = Buffer.concat([msg1, msg2]);
    const frames = accumulator.accumulate(combined);

    assert.strictEqual(frames.length, 2);
    assert.strictEqual(Buffer.compare(frames[0], msg1), 0);
    assert.strictEqual(Buffer.compare(frames[1], msg2), 0);
  });

  it('should reset correctly', () => {
    const accumulator = new RawMessageAccumulator();
    const encoded = encodeMessage({ test: true });

    // Feed partial
    accumulator.accumulate(encoded.subarray(0, 3));
    assert.ok(accumulator.pendingBytes > 0);

    // Reset
    accumulator.reset();
    assert.strictEqual(accumulator.pendingBytes, 0);
  });
});

describe('encodeRawWithPrefix', () => {
  it('should add length prefix to raw data', () => {
    const data = Buffer.from('hello world', 'utf-8');
    const encoded = encodeRawWithPrefix(data);

    assert.strictEqual(encoded.readUInt32LE(0), data.length);
    assert.strictEqual(
      Buffer.compare(encoded.subarray(LENGTH_PREFIX_SIZE), data),
      0
    );
  });
});

describe('extractPayload', () => {
  it('should extract payload from framed message', () => {
    const original = { test: 'data' };
    const frame = encodeMessage(original);
    const payload = extractPayload(frame);

    assert.deepStrictEqual(JSON.parse(payload.toString('utf-8')), original);
  });

  it('should throw on frame too short', () => {
    const short = Buffer.alloc(2);
    assert.throws(() => extractPayload(short), /too short/);
  });

  it('should throw on incomplete frame', () => {
    const frame = encodeMessage({ data: 'test' });
    const incomplete = frame.subarray(0, frame.length - 2);
    assert.throws(() => extractPayload(incomplete), /incomplete/);
  });
});

describe('Round-trip encoding/decoding', () => {
  it('should handle complex nested objects', () => {
    const decoder = new MessageDecoder();
    const complex = {
      type: 'mcp-request',
      id: 12345,
      method: 'tools/call',
      params: {
        name: 'search',
        arguments: {
          query: 'test query',
          filters: ['a', 'b', 'c'],
          options: {
            nested: {
              deeply: true,
            },
          },
        },
      },
    };

    const encoded = encodeMessage(complex);
    const decoded = decoder.decode(encoded);

    assert.strictEqual(decoded.length, 1);
    assert.deepStrictEqual(decoded[0], complex);
  });

  it('should handle arrays at top level', () => {
    const decoder = new MessageDecoder();
    const array = [1, 2, 3, { nested: 'value' }];

    const encoded = encodeMessage(array);
    const decoded = decoder.decode(encoded);

    assert.deepStrictEqual(decoded[0], array);
  });

  it('should handle null values', () => {
    const decoder = new MessageDecoder();
    const message = { value: null, nested: { also: null } };

    const encoded = encodeMessage(message);
    const decoded = decoder.decode(encoded);

    assert.deepStrictEqual(decoded[0], message);
  });

  it('should handle boolean values', () => {
    const decoder = new MessageDecoder();
    const message = { yes: true, no: false };

    const encoded = encodeMessage(message);
    const decoded = decoder.decode(encoded);

    assert.deepStrictEqual(decoded[0], message);
  });

  it('should handle numbers including floats', () => {
    const decoder = new MessageDecoder();
    const message = { int: 42, float: 3.14159, negative: -100, zero: 0 };

    const encoded = encodeMessage(message);
    const decoded = decoder.decode(encoded);

    assert.deepStrictEqual(decoded[0], message);
  });
});
