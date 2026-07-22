// Discord connector — fully supported via the official bot API (discord.js).
//
// Handles both direct messages to the bot and messages in server channels the
// bot can see. Requires the "Message Content" privileged intent (enable it in
// the Discord Developer Portal > your app > Bot > Privileged Gateway Intents).
//
// kind: 'gateway'  — it opens its own websocket and pushes messages to us.

export function createDiscordConnector({ token, logger = console }) {
  let client = null;

  async function start(emit) {
    if (!token) {
      logger.warn('[discord] no DISCORD_BOT_TOKEN set, connector disabled');
      return;
    }
    // Lazy import so the whole gateway doesn't hard-depend on discord.js
    // when Discord isn't configured.
    const { Client, GatewayIntentBits, Partials, ChannelType } = await import('discord.js');

    client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel], // needed to receive DMs
    });

    client.on('messageCreate', async (message) => {
      if (message.author?.bot) return; // ignore bots (incl. ourselves)
      if (!message.content) return;
      const isDM = message.channel?.type === ChannelType.DM;
      await emit({
        senderId: message.author.id,
        senderName: message.author.username,
        text: message.content,
        // Remember where to reply: DM channel or the guild channel.
        meta: { channelId: message.channel.id, isDM },
      });
    });

    client.once('ready', () => logger.info(`[discord] logged in as ${client.user.tag}`));
    await client.login(token);
  }

  // `to` is the Discord user id. We DM the user directly.
  async function send({ to, text }) {
    if (!client) throw new Error('[discord] connector not started');
    const user = await client.users.fetch(to);
    await user.send(text);
  }

  async function stop() {
    if (client) await client.destroy();
  }

  return { name: 'discord', kind: 'gateway', start, send, stop };
}

export default { createDiscordConnector };
