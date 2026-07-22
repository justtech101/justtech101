import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../src/classifier.js';

test('lead: pricing question', () => {
  const r = classify('Hi, how much is your pro plan? interested in pricing');
  assert.equal(r.category, 'lead');
  assert.equal(r.priority, 'medium');
  assert.equal(r.escalate, false);
});

test('support: something broken', () => {
  const r = classify("I can't login, the app keeps giving an error");
  assert.equal(r.category, 'support');
  assert.equal(r.priority, 'medium');
});

test('complaint: unhappy customer', () => {
  const r = classify('This is the worst service, absolutely terrible and unacceptable');
  assert.equal(r.category, 'complaint');
  assert.equal(r.priority, 'high');
});

test('spam: junk', () => {
  const r = classify('Make money fast with crypto! click here');
  assert.equal(r.category, 'spam');
  assert.equal(r.priority, 'low');
});

test('general: no keywords', () => {
  const r = classify('hey there, just saying hello');
  assert.equal(r.category, 'general');
  assert.equal(r.priority, 'low');
  assert.equal(r.escalate, false);
});

test('escalation: refund forces urgent + escalate', () => {
  const r = classify('I want a refund and I am calling my lawyer');
  assert.equal(r.escalate, true);
  assert.equal(r.priority, 'urgent');
  assert.ok(r.matched.escalation.includes('refund'));
  assert.ok(r.matched.escalation.includes('lawyer'));
});

test('escalation: chargeback on an otherwise-general message becomes complaint', () => {
  const r = classify('starting a chargeback dispute on my card');
  assert.equal(r.escalate, true);
  assert.equal(r.priority, 'urgent');
  assert.equal(r.category, 'complaint');
});

test('empty / non-string input is safe', () => {
  const r = classify(undefined);
  assert.equal(r.category, 'general');
  assert.equal(r.escalate, false);
});
