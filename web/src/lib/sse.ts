function emitFrame(frame: string, onData: (data: string) => void): void {
  const data = frame
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  if (data) onData(data);
}

export async function readSse(stream: ReadableStream<Uint8Array>, onData: (data: string) => void): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        if (buffer) emitFrame(buffer, onData);
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';
      for (const frame of frames) emitFrame(frame, onData);
    }
  } finally {
    reader.releaseLock();
  }
}
