import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRouter } from '../src/router.js';
import { classify } from '../src/classifier.js';

// A fake Chatwoot client that records calls instead of hitting the network.
function fakeChatwoot() {
  const calls = { contacts: [], conversations: [], messages: [], labels: [], priorities: [] };
  let convoSeq = 1000;
  return {
    calls,
    async findOrCreateContact(args) {
      calls.contacts.push(args);
      return { contactId: 42, sourceId: 'src-1' };
    },
    async createConversation(args) {
      calls.conversations.push(args);
      return convoSeq++;
    },
    async postIncomingMessage(args) {
      calls.messages.push(args);
    },
    async addLabels(args) {
      calls.labels.push(args);
    },
    async setPriority(args) {
      calls.priorities.push(args);
    },
  };
}

const config = {
  inboxes: { discord: 1, twitch: 2, instagram: 3, tiktok: 4 },
  inboxToPlatform: { 1: 'discord', 2: 'twitch', 3: 'instagram', 4: 'tiktok' },
};

const silentLogger = { info() {}, warn() {}, error() {} };

test('inbound: creates contact, conversation, message, labels, priority', async () => {
  const chatwoot = fakeChatwoot();
  const router = createRouter({ chatwoot, classify, connectors: {}, config, logger: silentLogger });

  const r = await router.handleInbound({
    platform: 'discord',
    senderId: '999',
    senderName: 'alice',
    text: 'how much does the pro plan cost?',
  });

  assert.equal(r.category, 'lead');
  assert.equal(chatwoot.calls.contacts[0].identifier, 'discord:999');
  assert.equal(chatwoot.calls.messages[0].content, 'how much does the pro plan cost?');
  assert.deepEqual(chatwoot.calls.labels[0].labels, ['discord', 'lead']);
  assert.equal(chatwoot.calls.priorities[0].priority, 'medium');
});

test('inbound: same sender threads into one conversation', async () => {
  const chatwoot = fakeChatwoot();
  const router = createRouter({ chatwoot, classify, connectors: {}, config, logger: silentLogger });

  const a = await router.handleInbound({ platform: 'twitch', senderId: '7', senderName: 'bob', text: 'hi' });
  const b = await router.handleInbound({ platform: 'twitch', senderId: '7', senderName: 'bob', text: 'still there?' });

  assert.equal(a.conversationId, b.conversationId);
  assert.equal(chatwoot.calls.conversations.length, 1); // only created once
});

test('inbound: escalation adds label and fires notify', async () => {
  const chatwoot = fakeChatwoot();
  const notified = [];
  const router = createRouter({
    chatwoot,
    classify,
    connectors: {},
    config,
    logger: silentLogger,
    notify: async (n) => notified.push(n),
  });

  await router.handleInbound({ platform: 'instagram', senderId: '5', senderName: 'carol', text: 'I demand a refund now' });

  assert.ok(chatwoot.calls.labels[0].labels.includes('escalation'));
  assert.equal(chatwoot.calls.priorities[0].priority, 'urgent');
  assert.equal(notified.length, 1);
  assert.equal(notified[0].platform, 'instagram');
});

test('inbound: unknown platform (no inbox) is skipped', async () => {
  const chatwoot = fakeChatwoot();
  const router = createRouter({ chatwoot, classify, connectors: {}, config, logger: silentLogger });
  const r = await router.handleInbound({ platform: 'myspace', senderId: '1', senderName: 'x', text: 'hi' });
  assert.equal(r.skipped, true);
  assert.equal(chatwoot.calls.contacts.length, 0);
});

test('outbound: forwards an agent reply to the right connector', async () => {
  const sent = [];
  const connectors = { discord: { send: async (a) => sent.push(a) } };
  const router = createRouter({ chatwoot: fakeChatwoot(), classify, connectors, config, logger: silentLogger });

  const r = await router.handleChatwootWebhook({
    event: 'message_created',
    message_type: 'outgoing',
    private: false,
    inbox: { id: 1 },
    content: 'Thanks for reaching out!',
    conversation: { meta: { sender: { identifier: 'discord:999' } } },
  });

  assert.equal(r.delivered, true);
  assert.equal(sent[0].to, '999');
  assert.equal(sent[0].text, 'Thanks for reaching out!');
});

test('outbound: ignores incoming echoes and private notes', async () => {
  const sent = [];
  const connectors = { discord: { send: async (a) => sent.push(a) } };
  const router = createRouter({ chatwoot: fakeChatwoot(), classify, connectors, config, logger: silentLogger });

  const incoming = await router.handleChatwootWebhook({ event: 'message_created', message_type: 'incoming' });
  const note = await router.handleChatwootWebhook({ event: 'message_created', message_type: 'outgoing', private: true });

  assert.equal(incoming.skipped, true);
  assert.equal(note.skipped, true);
  assert.equal(sent.length, 0);
});
