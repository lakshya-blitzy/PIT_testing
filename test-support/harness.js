'use strict';

const SERVER_PATH = '../src/server';

// src/server.js keeps its inventory and shipment registers in module scope, so the only
// way a case can start from empty registers is to drop the module registry entry and let
// the next require re-execute the module. src/server.js itself is never touched.
function reloadApp() {
  const resolved = require.resolve(SERVER_PATH);
  delete require.cache[resolved];
  return require(SERVER_PATH);
}

/**
 * Boots the exported app on an OS-assigned port, so concurrent test files never collide.
 * Each call reloads src/server.js, which gives the caller empty registers and shipment ids
 * that restart at SHP-1. The caller owns teardown and must await close() in a finally.
 *
 * @returns {Promise<{ url: string, close: () => Promise<void> }>}
 */
async function startApp() {
  const app = reloadApp();
  const server = app.listen(0);
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => {
          // A listener already released (a failure path closing twice) is not a teardown
          // failure; any other close error still surfaces.
          if (err && err.code !== 'ERR_SERVER_NOT_RUNNING') reject(err);
          else resolve();
        });
      }),
  };
}

// Express 4 renders an HTML page, with newlines, for a thrown handler error and for an
// unmatched path, and places the error message after roughly 110 characters of document
// markup. A body quoted in an error message is therefore collapsed to one line long enough
// to reach that message, so what came back is visible.
const BODY_PREVIEW_LIMIT = 200;

function previewBody(text) {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed === '') return '<empty body>';
  return collapsed.length > BODY_PREVIEW_LIMIT
    ? `"${collapsed.slice(0, BODY_PREVIEW_LIMIT)}..."`
    : `"${collapsed}"`;
}

/**
 * Sends one request over loopback and returns the parsed JSON response.
 *
 * A call with no body carries no content-type and no payload: that bodyless form is what
 * lets the dispatch route fall back to its default carrier, so it must stay bodyless
 * rather than carrying '{}' or a null payload.
 *
 * The body is read as text and parsed once so that a failing call still names itself: a
 * transport failure (refused, unreachable, or broken off mid-body) reports the method,
 * path and URL it did not complete, and a response that is not JSON (the app's own HTML
 * error page, or an empty body) reports the method, path, status, content-type and a slice
 * of the body rather than throwing a bare SyntaxError that discards the status already in
 * hand.
 *
 * @returns {Promise<{ status: number, body: any }>}
 */
async function request(url, method, pathname, body) {
  const options = { method };
  if (body !== undefined) {
    options.headers = { 'content-type': 'application/json' };
    options.body = JSON.stringify(body);
  }
  const target = `${url}${pathname}`;
  let response;
  try {
    response = await fetch(target, options);
  } catch (err) {
    throw new Error(`request ${method} ${pathname} could not be sent to ${target}`, {
      cause: err,
    });
  }
  // A connection torn down mid-body is a transport failure too, so it is reported the same
  // way rather than as a bare socket error with no request attached.
  let text;
  try {
    text = await response.text();
  } catch (err) {
    throw new Error(
      `request ${method} ${pathname} failed while reading the body from ${target}`,
      { cause: err },
    );
  }
  try {
    return { status: response.status, body: JSON.parse(text) };
  } catch {
    const contentType = response.headers.get('content-type') || 'none';
    throw new Error(
      `request ${method} ${pathname} answered ${response.status} ` +
        `(content-type: ${contentType}) with a body that is not JSON: ${previewBody(text)}`,
    );
  }
}

const postJson = (url, pathname, body) => request(url, 'POST', pathname, body);

const getJson = (url, pathname) => request(url, 'GET', pathname);

/**
 * Creates catalogue stock through the public intake route. The registers are not exported
 * and writing them directly would bypass the validation the cases exist to prove.
 * reorderLevel is omitted when not supplied, so the route's own default of 5 applies.
 *
 * @returns {Promise<{ sku: string, name: string, quantity: number, reorderLevel: number }>}
 */
async function seedItem(url, { sku, name, quantity, reorderLevel }) {
  const payload = { sku, name, quantity };
  if (reorderLevel !== undefined) payload.reorderLevel = reorderLevel;
  const response = await postJson(url, '/inventory', payload);
  if (response.status !== 201) {
    throw new Error(
      `seedItem could not create ${sku}: expected 201 but received ${response.status} ` +
        `${JSON.stringify(response.body)} for payload ${JSON.stringify(payload)}`,
    );
  }
  return response.body;
}

module.exports = { startApp, request, postJson, getJson, seedItem };
