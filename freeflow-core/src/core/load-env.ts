// Side-effect import: load freeflow-core/.env for local tools before anything reads process.env.
import { loadDotEnv } from "./dotenv.js";

loadDotEnv();
