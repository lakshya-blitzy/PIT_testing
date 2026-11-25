const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, postJson, getJson, seedItem } = require('../test-support/harness');

test('POST /inventory stores a valid item and applies the default reorderLevel of 5', async () => {
  const { url, close } = await startApp();
  try {
    const empty = await getJson(url, '/inventory');
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body, []);

    const defaulted = await postJson(url, '/inventory', {
      sku: 'SKU-INV-01',
      name: 'Bolt',
      quantity: 10,
    });
    assert.equal(defaulted.status, 201);
    assert.deepEqual(defaulted.body, {
      sku: 'SKU-INV-01',
      name: 'Bolt',
      quantity: 10,
      reorderLevel: 5,
    });

    const overridden = await postJson(url, '/inventory', {
      sku: 'SKU-INV-02',
      name: 'Nut',
      quantity: 4,
      reorderLevel: 12,
    });
    assert.equal(overridden.status, 201);
    assert.deepEqual(overridden.body, {
      sku: 'SKU-INV-02',
      name: 'Nut',
      quantity: 4,
      reorderLevel: 12,
    });

    const listed = await getJson(url, '/inventory');
    assert.equal(listed.status, 200);
    assert.equal(listed.body.length, 2);
    assert.deepEqual(
      listed.body.find((item) => item.sku === 'SKU-INV-01'),
      defaulted.body,
    );
    assert.deepEqual(
      listed.body.find((item) => item.sku === 'SKU-INV-02'),
      overridden.body,
    );
  } finally {
    await close();
  }
});

test('GET /inventory lists every stored item and is empty before any intake', async () => {
  const { url, close } = await startApp();
  try {
    const empty = await getJson(url, '/inventory');
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body, []);

    await seedItem(url, { sku: 'SKU-INV-01', name: 'Bolt', quantity: 10 });
    await seedItem(url, { sku: 'SKU-INV-02', name: 'Nut', quantity: 4, reorderLevel: 12 });

    const listed = await getJson(url, '/inventory');
    assert.equal(listed.status, 200);
    assert.equal(listed.body.length, 2);
    assert.deepEqual(listed.body.find((item) => item.sku === 'SKU-INV-01'), {
      sku: 'SKU-INV-01',
      name: 'Bolt',
      quantity: 10,
      reorderLevel: 5,
    });
    assert.deepEqual(listed.body.find((item) => item.sku === 'SKU-INV-02'), {
      sku: 'SKU-INV-02',
      name: 'Nut',
      quantity: 4,
      reorderLevel: 12,
    });
  } finally {
    await close();
  }
});

test('POST /inventory rejects a duplicate SKU and leaves the stored quantity unchanged', async () => {
  const { url, close } = await startApp();
  try {
    await seedItem(url, { sku: 'SKU-DUP-01', name: 'Bolt', quantity: 4 });

    const duplicate = await postJson(url, '/inventory', {
      sku: 'SKU-DUP-01',
      name: 'Bolt',
      quantity: 99,
    });
    assert.equal(duplicate.status, 409);
    assert.deepEqual(duplicate.body, { error: 'duplicate sku' });

    const listed = await getJson(url, '/inventory');
    assert.equal(listed.status, 200);
    assert.equal(listed.body.length, 1);
    assert.deepEqual(listed.body.find((item) => item.sku === 'SKU-DUP-01'), {
      sku: 'SKU-DUP-01',
      name: 'Bolt',
      quantity: 4,
      reorderLevel: 5,
    });
  } finally {
    await close();
  }
});

test('POST /inventory rejects a malformed payload and stores nothing', async () => {
  const { url, close } = await startApp();
  try {
    // Intake accepts a quantity of 0 (its guard is quantity < 0), so 0 is deliberately
    // absent from these rejected variants.
    const malformed = [
      { label: 'missing sku', payload: { name: 'Bolt', quantity: 4 } },
      { label: 'missing name', payload: { sku: 'SKU-BAD-02', quantity: 4 } },
      { label: 'fractional quantity', payload: { sku: 'SKU-BAD-03', name: 'Bolt', quantity: 1.5 } },
      { label: 'negative quantity', payload: { sku: 'SKU-BAD-04', name: 'Bolt', quantity: -1 } },
    ];

    for (const { label, payload } of malformed) {
      const response = await postJson(url, '/inventory', payload);
      assert.equal(response.status, 400, `${label}: expected 400 but received ${response.status}`);
      assert.deepEqual(
        response.body,
        { error: 'invalid inventory payload' },
        `${label}: unexpected error body`,
      );
    }

    const listed = await getJson(url, '/inventory');
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body, []);
  } finally {
    await close();
  }
});
