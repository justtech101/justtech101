import type { Ai } from "./ai.js";
import type { BusinessConfig, Env } from "./config.js";
import type { Mailer } from "./notify.js";
import type { Db } from "./store.js";
import type { Telephony } from "./telephony.js";

/** Everything a flow needs, injected so tests can swap in fakes and a fixed clock. */
export interface Deps {
  db: Db;
  telephony: Telephony;
  ai: Ai;
  mailer: Mailer;
  config: BusinessConfig;
  env: Env;
  clock: () => Date;
}
