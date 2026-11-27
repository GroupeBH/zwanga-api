'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { summarizeAlertCohort, reconcileAlertCohort, closeAlertCohort, checkAlertCohort } = require('./alert-cohort.cjs');

test('alert cohort separates late offers, observations and unresolved captured invitations', () => {
  const rows = [
    { offerId: 'a', notificationId: 'received', obsolete: false },
    { offerId: 'b', notificationId: 'retired', obsolete: true },
    { offerId: 'c', notificationId: 'pending', obsolete: false },
    { offerId: 'd', notificationId: null, obsolete: false },
  ];
  const result = summarizeAlertCohort(rows, new Set(['received', 'after-snapshot']), new Set(['received']), 6);
  assert.deepEqual(result, { capturedOffers: 4, notificationsMissing: 1,
    observedWithinCohort: 1, confirmedWithinCohort: 1, observedWithoutConfirmation: 0,
    unobservedObsolete: 1, unobservedWithdrawnDuringObservation: 0,
    unobservedNonObsolete: 1, confirmedWithoutObservation: 0,
    observedOutsideCohort: 1, offersCreatedAfterCapture: 2 });
  assert.ok(Object.values(result).every(v => typeof v === 'number'));
});

test('receipt mismatches remain explicit and unknown eligibility is not called obsolete', () => {
  const rows = [
    { notificationId: 'observed', obsolete: false },
    { notificationId: 'confirmed-only', obsolete: null },
  ];
  const r = summarizeAlertCohort(rows, new Set(['observed']), new Set(['confirmed-only']), 2);
  assert.equal(r.observedWithoutConfirmation, 1);
  assert.equal(r.confirmedWithoutObservation, 1);
  assert.equal(r.unobservedNonObsolete, 1);
  assert.equal(r.unobservedObsolete, 0);
  assert.equal(r.offersCreatedAfterCapture, 0);
});

test('cohort reconciliation queries only captured notification IDs with bound parameters', async () => {
  const id = 'b91dc63f-07eb-4582-923a-27f3e7ad3aab';
  const db = { query: async (sql, params) => {
    assert.match(sql, /ANY\(\$1::uuid\[\]\)/);
    assert.deepEqual(params, [[id]]);
    assert.ok(!sql.includes(id));
    return [{ notificationId: id }];
  } };
  const r = await reconcileAlertCohort(db, [{ notificationId: id }], new Set([id]), 2);
  assert.equal(r.confirmedWithinCohort, 1);
  assert.equal(r.offersCreatedAfterCapture, 1);
  assert.equal(JSON.stringify(r).includes(id), false);
});

test('empty cohort needs no receipt query and still reports late offers', async () => {
  const r = await reconcileAlertCohort({ query: () => assert.fail('Unexpected query') }, [], new Set(), 3);
  assert.equal(r.capturedOffers, 0);
  assert.equal(r.offersCreatedAfterCapture, 3);
});

test('closing state is scoped to captured offers and never rewrites initial eligibility', async () => {
  const rows = [{ offerId: 'a', notificationId: 'n', obsolete: false }, { offerId: 'b', obsolete: true }];
  const closed = await closeAlertCohort({ query: async (sql, params) => {
    assert.match(sql, /ANY\(\$1::uuid\[\]\)/);
    assert.deepEqual(params, [['a', 'b']]);
    return [{ id: 'a', status: 'expired' }];
  } }, rows);
  assert.equal(closed[0].closingStatus, 'expired');
  assert.equal(closed[0].obsolete, false);
  assert.equal(closed[1].closingStatus, undefined);
  assert.equal(rows[0].closingStatus, undefined);
});

test('expiry or missing state during observation cannot hide a missed live alert', () => {
  for (const closingStatus of ['expired', 'pending', undefined, 'unknown']) {
    const r = summarizeAlertCohort([{ notificationId: 'n', obsolete: false, closingStatus }], new Set(), new Set(), 1);
    assert.equal(r.unobservedNonObsolete, 1);
    assert.throws(() => checkAlertCohort(r), /unobservedNonObsolete/);
  }
});

test('business withdrawal during observation is separate from delivery and prior obsolescence', () => {
  for (const closingStatus of ['cancelled', 'accepted', 'declined']) {
    const r = summarizeAlertCohort([{ notificationId: 'n', obsolete: false, closingStatus }], new Set(), new Set(), 1);
    assert.equal(r.unobservedWithdrawnDuringObservation, 1);
    assert.equal(r.observedWithinCohort, 0);
    assert.equal(r.unobservedObsolete, 0);
    assert.doesNotThrow(() => checkAlertCohort(r));
  }
});

test('alert gate refuses missing evidence and every delivery inconsistency', () => {
  const clean = summarizeAlertCohort([{ notificationId: 'n', obsolete: false }], new Set(['n']), new Set(['n']), 1);
  assert.doesNotThrow(() => checkAlertCohort(clean));
  assert.throws(() => checkAlertCohort(undefined), /Alert cohort/);
  for (const key of ['notificationsMissing', 'observedWithoutConfirmation', 'unobservedNonObsolete', 'confirmedWithoutObservation']) {
    for (const value of [1, undefined, NaN]) assert.throws(() => checkAlertCohort({ ...clean, [key]: value }), /Alert cohort/);
  }
});
