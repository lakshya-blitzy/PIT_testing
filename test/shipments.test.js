const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, postJson, getJson, seedItem } = require('../test-support/harness');

// Every case boots its own app instance through the harness, which reloads src/server.js so
// both registers start empty and shipment ids restart at SHP-1. The registers are not
// exported, so state is only ever observed through a second request.

test('POST /shipments decrements stock and creates a created shipment with a SHP-n id', async () => {
  const { url, close } = await startApp();
  try {
    await seedItem(url, { sku: 'SKU-SHP-01', name: 'Bolt', quantity: 10 });

    const response = await postJson(url, '/shipments', {
      sku: 'SKU-SHP-01',
      quantity: 3,
      destination: 'Leeds',
    });
    assert.equal(response.status, 201);
    assert.deepEqual(response.body, {
      id: 'SHP-1',
      sku: 'SKU-SHP-01',
      quantity: 3,
      destination: 'Leeds',
      status: 'created',
    });
    assert.match(response.body.id, /^SHP-\d+$/);

    const listing = await getJson(url, '/inventory');
    assert.equal(listing.status, 200);
    assert.deepEqual(
      listing.body.find((item) => item.sku === 'SKU-SHP-01'),
      { sku: 'SKU-SHP-01', name: 'Bolt', quantity: 7, reorderLevel: 5 },
    );
  } finally {
    await close();
  }
});

test('POST /shipments rejects a quantity above stock on hand and leaves stock and shipments untouched', async () => {
  const { url, close } = await startApp();
  try {
    await seedItem(url, { sku: 'SKU-STK-01', name: 'Bolt', quantity: 2 });

    const response = await postJson(url, '/shipments', {
      sku: 'SKU-STK-01',
      quantity: 5,
      destination: 'Oslo',
    });
    assert.equal(response.status, 409);
    assert.deepEqual(response.body, { error: 'insufficient inventory' });

    const listing = await getJson(url, '/inventory');
    assert.equal(listing.status, 200);
    assert.deepEqual(
      listing.body.find((item) => item.sku === 'SKU-STK-01'),
      { sku: 'SKU-STK-01', name: 'Bolt', quantity: 2, reorderLevel: 5 },
    );

    const wouldBeShipment = await getJson(url, '/shipments/SHP-1');
    assert.equal(wouldBeShipment.status, 404);
    assert.deepEqual(wouldBeShipment.body, { error: 'shipment not found' });
  } finally {
    await close();
  }
});

test('POST /shipments rejects zero, negative and fractional quantities without touching stock', async () => {
  const { url, close } = await startApp();
  try {
    // The SKU must exist first: the look-up guard answers before the quantity guard.
    await seedItem(url, { sku: 'SKU-QTY-01', name: 'Bolt', quantity: 5 });

    for (const quantity of [0, -2, 1.5]) {
      const response = await postJson(url, '/shipments', {
        sku: 'SKU-QTY-01',
        quantity,
        destination: 'Oslo',
      });
      assert.equal(response.status, 400, `quantity ${quantity} must be refused with 400`);
      assert.deepEqual(
        response.body,
        { error: 'quantity must be positive' },
        `quantity ${quantity} must report the refusal`,
      );
    }

    const listing = await getJson(url, '/inventory');
    assert.equal(listing.status, 200);
    assert.deepEqual(
      listing.body.find((item) => item.sku === 'SKU-QTY-01'),
      { sku: 'SKU-QTY-01', name: 'Bolt', quantity: 5, reorderLevel: 5 },
    );

    const wouldBeShipment = await getJson(url, '/shipments/SHP-1');
    assert.equal(wouldBeShipment.status, 404);
    assert.deepEqual(wouldBeShipment.body, { error: 'shipment not found' });
  } finally {
    await close();
  }
});

test('POST /shipments returns 404 for a SKU that is not in the catalogue', async () => {
  const { url, close } = await startApp();
  try {
    const response = await postJson(url, '/shipments', {
      sku: 'SKU-MISSING',
      quantity: 1,
      destination: 'Oslo',
    });
    assert.equal(response.status, 404);
    assert.deepEqual(response.body, { error: 'sku not found' });

    const wouldBeShipment = await getJson(url, '/shipments/SHP-1');
    assert.equal(wouldBeShipment.status, 404);
    assert.deepEqual(wouldBeShipment.body, { error: 'shipment not found' });

    const listing = await getJson(url, '/inventory');
    assert.equal(listing.status, 200);
    assert.deepEqual(listing.body, []);
  } finally {
    await close();
  }
});

test('GET /shipments/:id returns the shipment and 404s for an unknown id', async () => {
  const { url, close } = await startApp();
  try {
    await seedItem(url, { sku: 'SKU-GET-01', name: 'Bolt', quantity: 6 });

    const created = await postJson(url, '/shipments', {
      sku: 'SKU-GET-01',
      quantity: 2,
      destination: 'York',
    });
    assert.equal(created.status, 201);
    assert.deepEqual(created.body, {
      id: 'SHP-1',
      sku: 'SKU-GET-01',
      quantity: 2,
      destination: 'York',
      status: 'created',
    });

    const found = await getJson(url, `/shipments/${created.body.id}`);
    assert.equal(found.status, 200);
    assert.deepEqual(found.body, {
      id: 'SHP-1',
      sku: 'SKU-GET-01',
      quantity: 2,
      destination: 'York',
      status: 'created',
    });

    const unknown = await getJson(url, '/shipments/SHP-99');
    assert.equal(unknown.status, 404);
    assert.deepEqual(unknown.body, { error: 'shipment not found' });
  } finally {
    await close();
  }
});
