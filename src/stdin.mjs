/**
 * Read a readable stream fully into a string. Never rejects: on a stream
 * 'error' it resolves with whatever was buffered so far, so callers can fail
 * open on an unreadable pipe instead of crashing. The stream is injectable so
 * this can be unit-tested without a real stdin.
 */
export function readStream(stream) {
  return new Promise((resolve) => {
    let data = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      data += chunk;
    });
    stream.on('end', () => resolve(data));
    stream.on('error', () => resolve(data));
  });
}
