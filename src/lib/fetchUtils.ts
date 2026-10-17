import http from 'http';
import https from 'https';

// Custom fetch wrapper using native http/https to support long timeouts
// bypassing Next.js/undici's hardcoded 5-minute headersTimeout limit.
/**
 * A minimal fetch-compatible Response over a finished node request.
 *
 * Callers expect `.get(name)` on headers like a real Response — without the
 * shim, reading one (e.g. `retry-after` on a 429) throws "Cannot read
 * properties of undefined".
 */
function buildResponseShim(res: any, bodyBuffer: Buffer) {
  const rawHeaders = res.headers || {};
  return {
    ok: res.statusCode ? res.statusCode >= 200 && res.statusCode < 300 : false,
    status: res.statusCode,
    headers: {
      get: (name: string): string | null => {
        const value = rawHeaders[String(name).toLowerCase()];
        if (value === undefined) return null;
        return Array.isArray(value) ? value.join(', ') : String(value);
      },
      raw: rawHeaders,
    },
    text: async () => bodyBuffer.toString('utf8'),
    json: async () => JSON.parse(bodyBuffer.toString('utf8')),
    arrayBuffer: async () =>
      bodyBuffer.buffer.slice(bodyBuffer.byteOffset, bodyBuffer.byteOffset + bodyBuffer.byteLength),
  };
}

/** FormData path: the platform fetch already handles multipart boundaries. */
async function fetchFormDataWithTimeout(urlStr: string, options: any, timeoutMs: number): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(urlStr, { ...options, signal: controller.signal });
  } catch (err: any) {
    if (err.name === 'AbortError') throw new Error(`Request timed out after ${timeoutMs} ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Everything else goes through node's http/https, which honours `timeout`. */
function nodeRequestWithTimeout(urlStr: string, options: any, timeoutMs: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const client = url.protocol === 'https:' ? https : http;

    const reqOptions: any = {
      method: options.method || 'GET',
      headers: options.headers || {},
      timeout: timeoutMs,
    };
    if (options.body) {
      reqOptions.headers['Content-Length'] = Buffer.byteLength(options.body);
    }

    const req = client.request(url, reqOptions, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(buildResponseShim(res, Buffer.concat(chunks))));
    });

    req.on('error', (err) => reject(err));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Request timed out after ${timeoutMs} ms`));
    });

    if (options.body) req.write(options.body);
    req.end();
  });
}

export async function fetchWithTimeout(urlStr: string, options: any = {}, timeoutMs = 30 * 60 * 1000): Promise<any> {
  const isFormData =
    options.body &&
    (typeof options.body.append === 'function' || options.body.constructor?.name === 'FormData');

  return isFormData
    ? fetchFormDataWithTimeout(urlStr, options, timeoutMs)
    : nodeRequestWithTimeout(urlStr, options, timeoutMs);
}


