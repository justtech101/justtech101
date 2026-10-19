// US-centric E.164 normalisation. Twilio already sends E.164; this covers
// manual entry ("706-555-0100") and keeps the leads.phone dedupe key stable.
export function normalizePhone(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.startsWith("+")) {
    const digits = trimmed.slice(1).replace(/\D/g, "");
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  }
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

// "+17065550100" -> "(706) 555-0100" for alerts and texts.
export function prettyPhone(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

// Read-back for voice: "7 0 6, 5 5 5, 0 1 0 0" so text-to-speech says digits.
export function spokenPhone(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  const groups = m ? [m[1], m[2], m[3]] : [e164.replace(/\D/g, "")];
  return groups.map((g) => g.split("").join(" ")).join(", ");
}
