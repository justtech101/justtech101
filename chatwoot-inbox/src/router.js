// The router is the brain. It has no knowledge of Express, Discord, TikTok etc.
// Everything it needs is injected, which is what makes it unit-testable.
//
//   inbound:  platform message  -> Chatwoot (contact/conversation/message + labels + priority)
//   outbound: Chatwoot webhook   -> the right connector's send()

export function createRouter({
  chatwoot,
  classify,
  connectors, // { discord: {send}, twitch: {send}, ... }
  config,
  notify, // async ({reason, platform, text, senderName}) => void   (optional)
  logger = console,
}) {
  // identifier keeps contacts unique across platforms: "discord:12345".
  const identifierFor = (platform, senderId) => `${platform}:${senderId}`;

  // Remember which conversation a given sender maps to so a back-and-forth
  // threads into one conversation. In-memory only — persist this (Redis/DB)
  // for a real deployment so restarts don't fork threads.
  const conversationByIdentifier = new Map();

  async function handleInbound({ platform, senderId, senderName, text }) {
    const inboxId = config.inboxes[platform];
    if (!inboxId) {
      logger.warn(`[router] no Chatwoot inbox configured for "${platform}", dropping message`);
      return { skipped: true, reason: 'no-inbox' };
    }

    const identifier = identifierFor(platform, senderId);
    const { contactId, sourceId } = await chatwoot.findOrCreateContact({
      inboxId,
      identifier,
      name: senderName || identifier,
    });

    let conversationId = conversationByIdentifier.get(identifier);
    if (!conversationId) {
      conversationId = await chatwoot.createConversation({
        inboxId,
        contactId,
        sourceId,
      });
      conversationByIdentifier.set(identifier, conversationId);
    }

    await chatwoot.postIncomingMessage({ conversationId, content: text });

    // Classify and decorate the conversation.
    const result = classify(text);
    const labels = [platform, result.category];
    if (result.escalate) labels.push('escalation');

    await chatwoot.addLabels({ conversationId, labels });
    if (result.priority) {
      await chatwoot.setPriority({ conversationId, priority: result.priority });
    }

    if (result.escalate && notify) {
      try {
        await notify({
          reason: result.matched.escalation?.join(', ') || 'escalation',
          platform,
          senderName: senderName || identifier,
          text,
        });
      } catch (e) {
        logger.error('[router] escalation notify failed:', e.message);
      }
    }

    logger.info(
      `[router] ${platform} <- ${senderName || identifier}: ${result.category}` +
        `${result.escalate ? ' (ESCALATE)' : ''} -> conv ${conversationId}`,
    );

    return { conversationId, contactId, ...result };
  }

  // Chatwoot fires this webhook on every message. We only forward agent
  // replies (outgoing, non-private) back out to the origin platform.
  async function handleChatwootWebhook(payload) {
    if (payload?.event !== 'message_created') return { skipped: true, reason: 'event' };
    if (payload.message_type !== 'outgoing') return { skipped: true, reason: 'not-outgoing' };
    if (payload.private) return { skipped: true, reason: 'private-note' };

    const inboxId =
      payload.inbox?.id ?? payload.conversation?.inbox_id ?? payload.inbox_id;
    const platform = config.inboxToPlatform[String(inboxId)];
    if (!platform) return { skipped: true, reason: 'unknown-inbox' };

    const connector = connectors[platform];
    if (!connector?.send) return { skipped: true, reason: 'no-connector' };

    const identifier = payload.conversation?.meta?.sender?.identifier;
    if (!identifier) return { skipped: true, reason: 'no-identifier' };

    // Strip the "platform:" prefix to get the raw platform user id.
    const to = identifier.startsWith(`${platform}:`)
      ? identifier.slice(platform.length + 1)
      : identifier;

    const content = payload.content || '';
    if (!content.trim()) return { skipped: true, reason: 'empty' };

    await connector.send({ to, text: content });
    logger.info(`[router] ${platform} -> ${to}: replied`);
    return { delivered: true, platform, to };
  }

  return { handleInbound, handleChatwootWebhook, conversationByIdentifier };
}

export default { createRouter };
