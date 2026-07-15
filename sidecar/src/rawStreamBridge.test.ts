import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { startRawResponse, writeRawChunk, type RawWritable } from './rawStreamBridge.js';

class FakeResponse extends EventEmitter implements RawWritable {
  writableEnded = false;
  destroyed = false;
  statusCode = 0;
  headers: Record<string, string> = {};
  chunks: Buffer[] = [];
  backpressure = false;

  status(code: number): this { this.statusCode = code; return this; }
  setHeader(name: string, value: string): void { this.headers[name.toLowerCase()] = value; }
  flushHeaders(): void {}
  write(chunk: Buffer): boolean { this.chunks.push(chunk); return !this.backpressure; }
  end(): void { this.writableEnded = true; }
  destroy(): void { this.destroyed = true; this.emit('close'); }
}

test('starts a raw response with only safe streaming headers', () => {
  const response = new FakeResponse();
  assert.equal(startRawResponse(response, 206, {
    'Content-Type': 'application/octet-stream',
    'Content-Range': 'bytes 0-3/10',
    'Set-Cookie': 'secret=value',
    Connection: 'keep-alive',
  }), true);
  assert.equal(response.statusCode, 206);
  assert.equal(response.headers['content-range'], 'bytes 0-3/10');
  assert.equal(response.headers['set-cookie'], undefined);
  assert.equal(response.headers.connection, undefined);
  assert.equal(response.headers['x-sidecar-stream-mode'], 'raw');
});

test('decodes chunks in order and waits for drain under backpressure', async () => {
  const response = new FakeResponse();
  assert.equal(await writeRawChunk(response, Buffer.from('first').toString('base64')), true);
  response.backpressure = true;
  const pending = writeRawChunk(response, Buffer.from('second').toString('base64'));
  let settled = false;
  void pending.then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  response.backpressure = false;
  response.emit('drain');
  assert.equal(await pending, true);
  assert.equal(Buffer.concat(response.chunks).toString(), 'firstsecond');
});

test('stops writing when the downstream closes', async () => {
  const response = new FakeResponse();
  response.backpressure = true;
  const pending = writeRawChunk(response, Buffer.from('data').toString('base64'));
  response.destroy();
  assert.equal(await pending, false);
  assert.equal(await writeRawChunk(response, Buffer.from('ignored').toString('base64')), false);
});
