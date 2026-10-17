// src/lib/apiRoute.ts
//
// One shape for every API route.
//
// 43 of the 44 routes wrapped their body in the same try/catch and turned the
// error into JSON — in eight different spellings, several of which read
// `err.message` off a value that is not guaranteed to be an Error (a thrown
// string or a rejected non-Error yields `undefined` as the message, so the
// caller gets `{"error": undefined}` and no idea what happened).
//
// `apiRoute` does that once: awaits the route params, runs the handler, and
// converts anything thrown into a JSON response with a sensible status. A
// handler can return a plain object and it is serialised, or return a
// NextResponse when it needs to control headers or streaming.

import { NextResponse } from 'next/server';

/**
 * An error with an HTTP status attached. Throw this from a handler for
 * anything the caller did wrong; everything else becomes a 500.
 */
export class HttpError extends Error {
  readonly status: number;
  /** Merged into the response body — e.g. `problems` from a validator. */
  readonly extra?: Record<string, unknown>;

  constructor(message: string, status = 400, extra?: Record<string, unknown>) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.extra = extra;
  }
}

/** Message from an unknown throw, without assuming it is an Error. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return String(err);
}

/**
 * Parses a JSON request body, or throws a 400.
 *
 * Routes used to write `await request.json().catch(() => ({}))`, which turns a
 * malformed body into an empty object and then fails later on a missing field
 * — reporting the wrong problem.
 */
export async function readJson<T = Record<string, unknown>>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new HttpError('Request body must be JSON.', 400);
  }
}

/** Same, but an absent/empty body is allowed and yields `{}`. */
export async function readOptionalJson<T = Record<string, unknown>>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    return {} as T;
  }
}

type RouteProps<P> = { params: Promise<P> };
/**
 * `R` lets a route ask for NextRequest when it needs `nextUrl`. Next always
 * passes a NextRequest at runtime, so widening the parameter here is safe —
 * the cast below is describing what actually arrives, not overriding it.
 */
type Handler<P, R extends Request = Request> = (request: R, ctx: { params: P }) => Promise<unknown>;

/**
 * Wraps a route handler with param resolution, JSON serialisation and error
 * handling.
 *
 * `label` is only used for the server-side log line, so a 500 can be traced to
 * a route without a stack trace in the client's response.
 */
export function apiRoute<P = Record<string, string>, R extends Request = Request>(
  label: string,
  handler: Handler<P, R>
) {
  return async (request: Request, props?: RouteProps<P>): Promise<NextResponse> => {
    try {
      const params = props?.params ? await props.params : ({} as P);
      const result = await handler(request as R, { params });
      // A handler that already built a response (headers, streams, redirects)
      // passes it straight through. Checked against Response, not NextResponse:
      // streaming routes construct a plain `new Response(stream)`, and testing
      // only for the subclass would serialise it into `{}`.
      return result instanceof Response ? (result as NextResponse) : NextResponse.json(result);
    } catch (err) {
      if (err instanceof HttpError) {
        return NextResponse.json({ error: err.message, ...(err.extra ?? {}) }, { status: err.status });
      }
      const message = errorMessage(err);
      console.error(`API ${label} failed:`, err);
      return NextResponse.json({ error: message }, { status: 500 });
    }
  };
}


