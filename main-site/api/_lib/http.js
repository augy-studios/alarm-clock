// Plumbing shared by the public endpoints.

import { redis } from './redis.js';
import { ValidationError, isId } from './validate.js';

const MAX_BODY = 32 * 1024;
const RATE_LIMIT = 120; // requests per IP per minute

export const json = (status, body) => Response.json(body, { status });
export const empty = (status = 204) => new Response(null, { status });

// Runs an endpoint behind the rate limit, and turns a ValidationError into a
// 400 and anything else into a 500.
export async function handle(request, fn) {
  try {
    if (await rateLimited(request)) return json(429, { error: 'too many requests' });
    return await fn();
  } catch (err) {
    if (err instanceof ValidationError) return json(400, { error: err.message });
    console.error(err);
    return json(500, { error: 'internal error' });
  }
}

// Instances don't share memory, so the count lives in Redis. Vercel sets
// x-real-ip itself; a client can't supply its own.
async function rateLimited(request) {
  const ip = request.headers.get('x-real-ip')
    ?? request.headers.get('x-forwarded-for')?.split(',')[0].trim()
    ?? 'unknown';
  const key = `alarm:rate:${ip}:${Math.floor(Date.now() / 60_000)}`;
  const [count] = await redis.pipeline().incr(key).expire(key, 60).exec();
  return count > RATE_LIMIT;
}

export async function readJson(request) {
  const text = await request.text();
  if (text.length > MAX_BODY) throw new ValidationError('body too large');
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new ValidationError('body is not valid JSON');
  }
}

// The device id comes as ?id=, so each endpoint is one plain file under api/
// with no rewrites in vercel.json.
export function deviceIdParam(request) {
  const id = new URL(request.url).searchParams.get('id');
  if (!isId(id)) throw new ValidationError('bad device id');
  return id;
}
