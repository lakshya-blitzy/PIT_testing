const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, postJson, getJson, seedItem } = require('../test-support/harness');

test('POST /shipments/:id/dispatch dispatches a created shipment and defaults the carrier to standard', async () => {
  const { url, close } = await startApp();
  try {
    await seedItem(url, { sku: 'SKU-DSP-01', name: 'Bolt', quantity: 9 });

    const firstCreated = await postJson(url, '/shipments', {
      sku: 'SKU-DSP-01',
      quantity: 1,
      destination: 'Leeds',
    });
    assert.equal(firstCreated.status, 201);

    const secondCreated = await postJson(url, '/shipments', {
      sku: 'SKU-DSP-01',
      quantity: 1,
      destination: 'Leeds',
    });
    assert.equal(secondCreated.status, 201);

    // No body and no content-type, so the route has to supply its own carrier.
    const defaulted = await postJson(url, `/shipments/${firstCreated.body.id}/dispatch`);
    assert.equal(defaulted.status, 200);
    assert.deepEqual(defaulted.body, {
      id: 'SHP-1',
      sku: 'SKU-DSP-01',
      quantity: 1,
      destination: 'Leeds',
      status: 'dispatched',
      carrier: 'standard',
    });

    const overridden = await postJson(url, `/shipments/${secondCreated.body.id}/dispatch`, {
      carrier: 'dhl',
    });
    assert.equal(overridden.status, 200);
    assert.deepEqual(overridden.body, {
      id: 'SHP-2',
      sku: 'SKU-DSP-01',
      quantity: 1,
      destination: 'Leeds',
      status: 'dispatched',
      carrier: 'dhl',
    });

    // The look-up route reads the stored record, so it shows the mutations persisted
    // rather than being echoed back by the dispatch response alone.
    const rereadDefaulted = await getJson(url, `/shipments/${firstCreated.body.id}`);
    assert.equal(rereadDefaulted.status, 200);
    assert.deepEqual(rereadDefaulted.body, defaulted.body);

    const rereadOverridden = await getJson(url, `/shipments/${secondCreated.body.id}`);
    assert.equal(rereadOverridden.status, 200);
    assert.deepEqual(rereadOverridden.body, overridden.body);
  } finally {
    await close();
  }
});

test('POST /shipments/:id/dispatch refuses a shipment that is not in created status', async () => {
  const { url, close } = await startApp();
  try {
    await seedItem(url, { sku: 'SKU-ALR-01', name: 'Bolt', quantity: 4 });

    const created = await postJson(url, '/shipments', {
      sku: 'SKU-ALR-01',
      quantity: 1,
      destination: 'Leeds',
    });
    assert.equal(created.status, 201);

    // The first dispatch is asserted so the second one is a genuine status conflict.
    const dispatched = await postJson(url, `/shipments/${created.body.id}/dispatch`);
    assert.equal(dispatched.status, 200);
    assert.deepEqual(dispatched.body, {
      id: 'SHP-1',
      sku: 'SKU-ALR-01',
      quantity: 1,
      destination: 'Leeds',
      status: 'dispatched',
      carrier: 'standard',
    });

    // This attempt names a carrier no dispatch in this case has used, so a handler that ran
    // the status mutation ahead of the status guard would leave it on the record and the
    // reread below would catch it.
    const refused = await postJson(url, `/shipments/${created.body.id}/dispatch`, {
      carrier: 'dhl',
    });
    assert.equal(refused.status, 409);
    assert.deepEqual(refused.body, { error: 'shipment cannot be dispatched' });

    const reread = await getJson(url, `/shipments/${created.body.id}`);
    assert.equal(reread.status, 200);
    assert.deepEqual(reread.body, {
      id: 'SHP-1',
      sku: 'SKU-ALR-01',
      quantity: 1,
      destination: 'Leeds',
      status: 'dispatched',
      carrier: 'standard',
    });
  } finally {
    await close();
  }
});

test('POST /shipments/:id/dispatch returns 404 for an id that does not exist', async () => {
  const { url, close } = await startApp();
  try {
    const response = await postJson(url, '/shipments/SHP-99/dispatch');

    // The look-up guard answers before the status check and the status mutation, so this
    // 404 for an absent id is the response that only that guard can produce; there is no
    // stored record afterwards to re-read.
    assert.equal(response.status, 404);
    assert.deepEqual(response.body, { error: 'shipment not found' });
  } finally {
    await close();
  }
});
