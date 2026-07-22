// Thin client over the Chatwoot Application API.
//
// Docs: https://www.chatwoot.com/developers/api/
// All calls target:  {url}/api/v1/accounts/{accountId}/...
// Auth header:       api_access_token: {apiToken}
//
// The flow for an inbound message on an "API" inbox is:
//   1. find-or-create a Contact (gives us a contact_id + a source_id)
//   2. find-or-create a Conversation for that contact
//   3. post the message as message_type: "incoming"

export function createChatwootClient({ url, accountId, apiToken, fetchImpl } = {}) {
  const doFetch = fetchImpl || fetch;
  const base = `${url}/api/v1/accounts/${accountId}`;

  async function api(path, { method = 'GET', body } = {}) {
    const res = await doFetch(`${base}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        api_access_token: apiToken,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    if (!res.ok) {
      const err = new Error(`Chatwoot ${method} ${path} -> ${res.status}`);
      err.status = res.status;
      err.body = data;
      throw err;
    }
    return data;
  }

  // identifier is a globally-unique string we control, e.g. "discord:12345".
  async function findOrCreateContact({ inboxId, identifier, name }) {
    try {
      const created = await api('/contacts', {
        method: 'POST',
        body: { inbox_id: inboxId, name, identifier },
      });
      const contact = created?.payload?.contact ?? created?.payload ?? created;
      const sourceId = contact?.contact_inboxes?.[0]?.source_id;
      return { contactId: contact.id, sourceId };
    } catch (err) {
      // 422 = contact with this identifier already exists. Look it up.
      if (err.status !== 422) throw err;
      const found = await api(
        `/contacts/search?q=${encodeURIComponent(identifier)}`,
      );
      const contact = (found?.payload || []).find(
        (c) => c.identifier === identifier,
      ) || found?.payload?.[0];
      if (!contact) throw err;
      const sourceId = contact?.contact_inboxes?.[0]?.source_id;
      return { contactId: contact.id, sourceId };
    }
  }

  async function createConversation({ inboxId, contactId, sourceId }) {
    const convo = await api('/conversations', {
      method: 'POST',
      body: { inbox_id: inboxId, contact_id: contactId, source_id: sourceId },
    });
    return convo.id;
  }

  async function postIncomingMessage({ conversationId, content }) {
    return api(`/conversations/${conversationId}/messages`, {
      method: 'POST',
      body: { content, message_type: 'incoming' },
    });
  }

  async function addLabels({ conversationId, labels }) {
    return api(`/conversations/${conversationId}/labels`, {
      method: 'POST',
      body: { labels },
    });
  }

  async function setPriority({ conversationId, priority }) {
    return api(`/conversations/${conversationId}/toggle_priority`, {
      method: 'POST',
      body: { priority },
    });
  }

  return {
    api,
    findOrCreateContact,
    createConversation,
    postIncomingMessage,
    addLabels,
    setPriority,
  };
}

export default { createChatwootClient };
