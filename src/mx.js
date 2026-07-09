// Optional MX-lookup hint for the enrollment UI. Purely a UX convenience to
// suggest a provider button — it NEVER overrides the provider recorded at
// enrollment (which is whichever OAuth flow the user actually completed).
import { resolveMx } from "dns/promises";

export async function guessProvider(domain) {
  try {
    const hosts = (await resolveMx(domain)).map((r) => r.exchange.toLowerCase()).join(" ");
    if (hosts.includes("outlook.com") || hosts.includes("protection.outlook.com")) return "microsoft";
    if (hosts.includes("google.com") || hosts.includes("googlemail.com")) return "google";
    return null;
  } catch {
    return null;
  }
}
