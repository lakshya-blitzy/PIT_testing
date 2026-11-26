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
  // The loopback address is passed explicitly: without a host the listener would accept
  // connections on every host interface for the life of the case.
  const { server, port } = await new Promise((resolve, reject) => {
    const listener = app.listen(0, '127.0.0.1');
    const onError = (err) => {
      // A failed bind leaves a listener the caller never receives, so it is released first;
      // a boot that never bound answers that close with ERR_SERVER_NOT_RUNNING, which is
      // expected here and not a second failure to report.
      listener.close(() => {
        reject(new Error(`startApp could not bind the app: ${err.message}`, { cause: err }));
      });
    };
    listener.once('error', onError);
    listener.once('listening', () => {
      // The boot is over, so a later socket error belongs to whoever drives the app rather
      // than to this rejection path, and it must surface instead of being swallowed.
      listener.removeListener('error', onError);
      const address = listener.address();
      if (address === null) {
        // The caller never receives a listener handle, so the one the boot created is
        // released before the boot reports that it has no port to hand out.
        listener.close(() => {
          reject(new Error('startApp booted a listener that reports no address'));
        });
        return;
      }
      resolve({ server: listener, port: address.port });
    });
  });
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
// unmatched path, and places the error message after a fixed run of document markup. A body
// quoted in an error message is therefore collapsed to one line long enough to reach that
// message, so what came back is visible.
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
 * A call with no body carries no content-type and no payload: that bodyless form is the
 * shape a dispatch that has not chosen a carrier sends, so the route supplies its default.
 *
 * The body is read as text and parsed once rather than through response.json(), so a
 * failing call still names itself and keeps the status it already has.
 *
 * @param {string} url Base url returned by startApp.
 * @param {string} method HTTP method to send.
 * @param {string} pathname Path to request, resolved against url.
 * @param {any} [body] Payload to serialise as JSON; omitted for a bodyless request.
 * @returns {Promise<{ status: number, body: any }>}
 */
async function request(url, method, pathname, body) {
  const options = { method };
  if (body !== undefined) {
    options.headers = { 'content-type': 'application/json' };
    options.body = JSON.stringify(body);
  }
  // Resolved against the base url and then held to its origin, so no pathname can rewrite
  // the authority and send the request or its body to another host.
  const target = new URL(pathname, url);
  if (target.origin !== new URL(url).origin) {
    throw new Error(
      `request ${method} ${pathname} resolved to ${target.href}, which leaves the base url ${url}`,
    );
  }
  let response;
  try {
    response = await fetch(target, options);
  } catch (err) {
    throw new Error(`request ${method} ${pathname} could not be sent to ${target.href}`, {
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
      `request ${method} ${pathname} failed while reading the body from ${target.href}`,
      { cause: err },
    );
  }
  try {
    return { status: response.status, body: JSON.parse(text) };
  } catch {
    const contentType = response.headers.get('content-type') || 'none';
    throw new Error(
      `request ${method} ${pathname} answered ${response.status} from ${target.href} ` +
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
 * Throws when the route does not answer 201, with an Error naming the SKU and the status and
 * body that came back, so a failed seed stops its case with what the route returned.
 *
 * @param {string} url Base url returned by startApp.
 * @param {{ sku: string, name: string, quantity: number, reorderLevel?: number }} item
 *   Item to create; reorderLevel is optional.
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
