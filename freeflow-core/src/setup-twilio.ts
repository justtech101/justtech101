// Step 5 helper: find, buy and wire up a Twilio number in one place.
//   npm run twilio -- search [areaCode]          list local numbers that do voice + SMS (default 706)
//   npm run twilio -- buy <+1706...> --confirm   buy it AND point its webhooks here (costs money)
//   npm run twilio -- configure [<+1706...>]     point an existing number's webhooks here
//   npm run twilio -- check [<+1706...>]         show what a number's webhooks point at now
// Uses TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / PUBLIC_BASE_URL / TWILIO_PHONE_NUMBER from the env.
import "./core/load-env.js";
import twilio from "twilio";
import { loadEnv } from "./core/config.js";
import { isMain } from "./core/paths.js";
import { normalizePhone } from "./core/phone.js";

/** The four webhook settings every business number needs (see README "Deploy"). */
export function webhookConfig(baseUrl: string) {
  const base = baseUrl.replace(/\/$/, "");
  return {
    voiceUrl: `${base}/voice/incoming`,
    voiceMethod: "POST",
    voiceFallbackUrl: `${base}/voice/fallback`,
    voiceFallbackMethod: "POST",
    statusCallback: `${base}/voice/status`,
    statusCallbackMethod: "POST",
    smsUrl: `${base}/sms/incoming`,
    smsMethod: "POST",
  } as const;
}

async function main() {
  const [cmd, arg, ...rest] = process.argv.slice(2);
  const env = loadEnv({ DATABASE_URL: "unused", ...process.env });
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) throw new Error("Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN first.");
  const client = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
  const needBase = () => {
    if (!env.PUBLIC_BASE_URL.startsWith("https://")) throw new Error("Set PUBLIC_BASE_URL to the deployed https:// URL first.");
    return webhookConfig(env.PUBLIC_BASE_URL);
  };
  const target = () => {
    const n = normalizePhone(arg ?? env.TWILIO_PHONE_NUMBER);
    if (!n) throw new Error("Give a number (E.164) or set TWILIO_PHONE_NUMBER.");
    return n;
  };
  const findOwned = async (n: string) => {
    const [owned] = await client.incomingPhoneNumbers.list({ phoneNumber: n, limit: 1 });
    if (!owned) throw new Error(`${n} is not on this Twilio account.`);
    return owned;
  };

  switch (cmd) {
    case "search": {
      const areaCode = Number(arg ?? 706);
      const found = await client.availablePhoneNumbers("US").local.list({ areaCode, smsEnabled: true, voiceEnabled: true, limit: 10 });
      if (!found.length) console.log(`No voice+SMS numbers available in ${areaCode} right now.`);
      for (const n of found) console.log(`${n.phoneNumber}  ${n.locality ?? ""}, ${n.region ?? ""}`);
      break;
    }
    case "buy": {
      const n = target();
      if (!rest.includes("--confirm")) {
        console.log(`This buys ${n} on your Twilio account (monthly charge). Re-run with --confirm to proceed.`);
        return;
      }
      const bought = await client.incomingPhoneNumbers.create({ phoneNumber: n, friendlyName: `freeflow-core ${env.DEPLOY_ENV}`, ...needBase() });
      console.log(`Bought ${bought.phoneNumber} (${bought.sid}) and pointed it at ${env.PUBLIC_BASE_URL}.`);
      console.log(`Next: set TWILIO_PHONE_NUMBER=${bought.phoneNumber} on the ${env.DEPLOY_ENV} service, and register it for A2P 10DLC texting.`);
      break;
    }
    case "configure": {
      const owned = await findOwned(target());
      await client.incomingPhoneNumbers(owned.sid).update(needBase());
      console.log(`${owned.phoneNumber} now points at ${env.PUBLIC_BASE_URL}.`);
      break;
    }
    case "check": {
      const owned = await findOwned(target());
      const want = env.PUBLIC_BASE_URL.startsWith("https://") ? webhookConfig(env.PUBLIC_BASE_URL) : null;
      const have: Record<string, string | null | undefined> = {
        voiceUrl: owned.voiceUrl, voiceFallbackUrl: owned.voiceFallbackUrl, statusCallback: owned.statusCallback, smsUrl: owned.smsUrl,
      };
      for (const [k, v] of Object.entries(have)) {
        const expected = want ? (want as any)[k] : null;
        console.log(`${k.padEnd(17)} ${v || "(not set)"}${expected && expected !== v ? `   <-- expected ${expected}` : ""}`);
      }
      break;
    }
    default:
      console.log("Usage: npm run twilio -- search [areaCode] | buy <number> --confirm | configure [number] | check [number]");
  }
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message ?? err);
    process.exit(1);
  });
}
