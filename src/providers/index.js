// Provider registry: name -> adapter module. The rest of the app is
// provider-agnostic and depends only on the common interface (buildAuthorizeUrl,
// exchangeCode, refreshAccessToken, sendMail, and the read methods listRecent,
// getCounts, search, getMessage).
import * as microsoft from "./microsoft.js";
import * as google from "./google.js";

const registry = { microsoft, google };

export function getProvider(name) {
  const p = registry[name];
  if (!p) throw new Error(`Unknown provider: ${name}`);
  return p;
}

export const PROVIDER_NAMES = Object.keys(registry);
