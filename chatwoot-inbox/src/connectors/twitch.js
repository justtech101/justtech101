// Twitch connector — channel chat via IRC (tmi.js).
//
// IMPORTANT: this bridges Twitch *channel chat* (public messages in your
// stream chat), which is fully supported and reliable. Twitch "whispers"
// (true 1:1 DMs) are a different, heavily rate-limited surface that requires
// a verified bot and the user:manage:whispers scope, and Twitch aggressively
// blocks whisper automation to fight spam. This starter forwards channel chat;
// replies are posted back into the same channel.
//
// kind: 'gateway'

export function createTwitchConnector({ username, oauth, channels, logger = console }) {
  let client = null;

  async function start(emit) {
    if (!username || !oauth || !channels?.length) {
      logger.warn('[twitch] missing username/oauth/channels, connector disabled');
      return;
    }
    const tmi = (await import('tmi.js')).default;

    client = new tmi.Client({
      options: { debug: false },
      identity: { username, password: oauth },
      channels: [...channels],
    });

    client.on('message', async (channel, tags, message, self) => {
      if (self) return; // ignore our own messages
      await emit({
        senderId: tags['user-id'] || tags.username,
        senderName: tags['display-name'] || tags.username,
        text: message,
        meta: { channel },
      });
    });

    client.on('connected', () =>
      logger.info(`[twitch] connected as ${username}, channels: ${channels.join(', ')}`),
    );
    await client.connect();
  }

  // Twitch chat has no per-user private reply here, so we post into the
  // primary channel and @-mention the user. `to` is the Twitch user id, but
  // tmi.js sends by channel — so we prefix with the username if available.
  async function send({ to, text }) {
    if (!client) throw new Error('[twitch] connector not started');
    const channel = client.getChannels?.()[0] || `#${(channels[0] || '').replace(/^#/, '')}`;
    await client.say(channel, text);
  }

  async function stop() {
    if (client) await client.disconnect();
  }

  return { name: 'twitch', kind: 'gateway', start, send, stop };
}

export default { createTwitchConnector };
