/**
 * Chrome Native Messaging Protocol utilities
 *
 * Protocol format:
 * - 4-byte little-endian uint32 length prefix
 * - UTF-8 JSON payload
 */

/**
 * Maximum message size from native host to Chrome (1MB)
 */
export const MAX_MESSAGE_SIZE_TO_CHROME = 1024 * 1024;

/**
 * Maximum message size from Chrome to native host (64MB)
 */
export const MAX_MESSAGE_SIZE_FROM_CHROME = 64 * 1024 * 1024;

/**
 * Length prefix size in bytes
 */
export const LENGTH_PREFIX_SIZE = 4;

/**
 * Encode a message with 4-byte little-endian length prefix
 * @param message - Object to encode as JSON
 * @returns Buffer with length prefix + UTF-8 JSON payload
 */
export function encodeMessage(message: unknown): Buffer {
  const jsonString = JSON.stringify(message);
  const payload = Buffer.from(jsonString, 'utf-8');

  if (payload.length > MAX_MESSAGE_SIZE_TO_CHROME) {
    throw new Error(
      `Message size ${payload.length} exceeds maximum ${MAX_MESSAGE_SIZE_TO_CHROME}`
    );
  }

  const header = Buffer.alloc(LENGTH_PREFIX_SIZE);
  header.writeUInt32LE(payload.length, 0);

  return Buffer.concat([header, payload]);
}

/**
 * Message decoder that handles partial reads from streams.
 * Maintains internal buffer for accumulating data across chunks.
 */
export class MessageDecoder {
  private buffer: Buffer = Buffer.alloc(0);
  private expectedLength: number | null = null;

  /**
   * Add incoming data and extract complete messages
   * @param chunk - Incoming data chunk
   * @returns Array of decoded message objects
   */
  decode(chunk: Buffer): unknown[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages: unknown[] = [];

    while (true) {
      // Need at least 4 bytes for length prefix
      if (this.buffer.length < LENGTH_PREFIX_SIZE) {
        break;
      }

      // Read expected length if not yet known
      if (this.expectedLength === null) {
        this.expectedLength = this.buffer.readUInt32LE(0);

        if (this.expectedLength > MAX_MESSAGE_SIZE_FROM_CHROME) {
          throw new Error(
            `Message size ${this.expectedLength} exceeds maximum ${MAX_MESSAGE_SIZE_FROM_CHROME}`
          );
        }
      }

      // Check if we have complete message
      const totalLength = LENGTH_PREFIX_SIZE + this.expectedLength;
      if (this.buffer.length < totalLength) {
        break;
      }

      // Extract and parse message
      const payload = this.buffer.subarray(LENGTH_PREFIX_SIZE, totalLength);
      const jsonString = payload.toString('utf-8');

      try {
        messages.push(JSON.parse(jsonString));
      } catch (err) {
        throw new Error(`Invalid JSON in message: ${err}`);
      }

      // Remove processed message from buffer
      this.buffer = this.buffer.subarray(totalLength);
      this.expectedLength = null;
    }

    return messages;
  }

  /**
   * Reset decoder state (clear buffer and expected length)
   */
  reset(): void {
    this.buffer = Buffer.alloc(0);
    this.expectedLength = null;
  }

  /**
   * Get current buffer size (for debugging)
   */
  get pendingBytes(): number {
    return this.buffer.length;
  }
}

/**
 * Raw message accumulator for TCP relay.
 * Extracts length-prefixed messages without JSON parsing.
 * Returns complete frames including the length prefix.
 */
export class RawMessageAccumulator {
  private buffer: Buffer = Buffer.alloc(0);

  /**
   * Add data and extract complete framed messages (including length prefix)
   * @param chunk - Incoming data chunk
   * @returns Array of complete frames (each includes its length prefix)
   */
  accumulate(chunk: Buffer): Buffer[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames: Buffer[] = [];

    while (this.buffer.length >= LENGTH_PREFIX_SIZE) {
      const length = this.buffer.readUInt32LE(0);
      const totalLength = LENGTH_PREFIX_SIZE + length;

      if (this.buffer.length < totalLength) {
        break;
      }

      // Return complete frame including length prefix
      frames.push(Buffer.from(this.buffer.subarray(0, totalLength)));
      this.buffer = this.buffer.subarray(totalLength);
    }

    return frames;
  }

  /**
   * Reset accumulator state
   */
  reset(): void {
    this.buffer = Buffer.alloc(0);
  }

  /**
   * Get current buffer size (for debugging)
   */
  get pendingBytes(): number {
    return this.buffer.length;
  }
}

/**
 * Encode raw bytes with length prefix (for TCP relay)
 * @param data - Raw data to encode
 * @returns Buffer with length prefix + data
 */
export function encodeRawWithPrefix(data: Buffer): Buffer {
  const header = Buffer.alloc(LENGTH_PREFIX_SIZE);
  header.writeUInt32LE(data.length, 0);
  return Buffer.concat([header, data]);
}

/**
 * Extract payload from a framed message (removes length prefix)
 * @param frame - Complete frame with length prefix
 * @returns Payload without length prefix
 */
export function extractPayload(frame: Buffer): Buffer {
  if (frame.length < LENGTH_PREFIX_SIZE) {
    throw new Error('Frame too short to contain length prefix');
  }
  const length = frame.readUInt32LE(0);
  if (frame.length < LENGTH_PREFIX_SIZE + length) {
    throw new Error('Frame is incomplete');
  }
  return frame.subarray(LENGTH_PREFIX_SIZE, LENGTH_PREFIX_SIZE + length);
}
