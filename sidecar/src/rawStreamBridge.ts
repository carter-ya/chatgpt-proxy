import type { EventEmitter } from 'events';

export interface RawWritable extends EventEmitter {
  writableEnded: boolean;
  destroyed: boolean;
  status(code: number): RawWritable;
  setHeader(name: string, value: string): void;
  flushHeaders?: () => void;
  write(chunk: Buffer): boolean;
  end(): void;
  destroy(error?: Error): void;
}

const forwardedResponseHeaders = new Set([
  'accept-ranges',
  'cache-control',
  'content-disposition',
  'content-length',
  'content-range',
  'content-type',
  'etag',
  'last-modified',
]);

export function startRawResponse(res: RawWritable, status: number, headers: Record<string, string>): boolean {
  if (res.destroyed || res.writableEnded) return false;
  res.status(status);
  for (const [name, value] of Object.entries(headers)) {
    if (forwardedResponseHeaders.has(name.toLowerCase()) && value) {
      res.setHeader(name, value);
    }
  }
  res.setHeader('x-sidecar-stream-mode', 'raw');
  res.flushHeaders?.();
  return true;
}

export async function writeRawChunk(res: RawWritable, chunkBase64: string): Promise<boolean> {
  if (res.destroyed || res.writableEnded) return false;
  const chunk = Buffer.from(chunkBase64, 'base64');
  if (chunk.length === 0) return true;
  if (res.write(chunk)) return true;
  return new Promise<boolean>((resolve) => {
    const cleanup = () => {
      res.off('drain', onDrain);
      res.off('close', onClose);
      res.off('error', onClose);
    };
    const onDrain = () => {
      cleanup();
      resolve(!res.destroyed && !res.writableEnded);
    };
    const onClose = () => {
      cleanup();
      resolve(false);
    };
    res.once('drain', onDrain);
    res.once('close', onClose);
    res.once('error', onClose);
  });
}
