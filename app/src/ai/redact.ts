// Redaction before any statement leaves the PSP: emails, phone numbers,
// street-address patterns and card-like numbers are replaced with tags.
// Order matters: card numbers before phones (both are digit runs).

const CARD = /\b\d(?:[ -]?\d){12,18}\b/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE = /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)|\d{2,4})[\s.-]?\d{3,4}[\s.-]?\d{3,4}\b/g;
// "4417 N Kedzie Ave", "221B Baker Street", "Calle Reforma 222", "Av. Insurgentes Sur 1602", "Rua Augusta, 1500"
const STREET_EN =
  /\b\d{1,6}[A-Za-z]?\s+(?:[NSEW]\.?\s+)?(?:[A-Z][a-z]+\s+){1,3}(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Way|Ct|Court|Pl|Place)\b\.?(?:,\s*[A-Z][a-z]+(?:\s[A-Z][a-z]+)*)?(?:,\s*[A-Z]{2}\s*\d{5})?/g;
const STREET_ES_PT = /\b(?:Calle|C\/|Av\.?|Avenida|Rua|Travessa|Carrera|Cra\.?)\s+(?:[A-ZÁÉÍÓÚ][\wáéíóúñç]+\s*){1,4},?\s*\d{1,5}\b/g;

export interface Redacted {
  text: string;
  counts: { email: number; phone: number; address: number; card: number };
}

export function redact(input: string): Redacted {
  const counts = { email: 0, phone: 0, address: 0, card: 0 };
  let t = input;
  t = t.replace(EMAIL, () => (counts.email++, "[EMAIL]"));
  t = t.replace(STREET_EN, () => (counts.address++, "[ADDRESS]"));
  t = t.replace(STREET_ES_PT, () => (counts.address++, "[ADDRESS]"));
  t = t.replace(CARD, (m) => {
    const digits = m.replace(/\D/g, "");
    if (digits.length < 13) return m;
    counts.card++;
    return "[CARD]";
  });
  t = t.replace(PHONE, (m) => {
    const digits = m.replace(/\D/g, "");
    if (digits.length < 9) return m; // amounts, years, order numbers
    counts.phone++;
    return "[PHONE]";
  });
  return { text: t, counts };
}
