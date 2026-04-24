/* eslint-disable */
/* =========================================================
   Chip Parser — convincing regex-based brief extractor
   Returns { count, deadline, format, platform, objective, tone, audience, keyMessage, aspectRatios }
   Each chip: { value, detected: true, raw } — or null
   ========================================================= */

const PLATFORMS = [
  { re: /\b(instagram|ig|insta)\b/i, label: "Instagram" },
  { re: /\btiktok\b/i, label: "TikTok" },
  { re: /\b(meta|facebook|fb)\b/i, label: "Meta" },
  { re: /\btwitter|x\.com|\bon x\b/i, label: "X" },
  { re: /\blinkedin\b/i, label: "LinkedIn" },
  { re: /\byoutube\b/i, label: "YouTube" },
  { re: /\bpinterest\b/i, label: "Pinterest" },
  { re: /\bemail\b/i, label: "Email" },
  { re: /\b(website|web|landing)\b/i, label: "Web" },
];

const FORMATS = [
  { re: /\b(static|posts?|banners?|images?|photos?|photography)\b/i, label: "Static" },
  { re: /\b(motion|video|reels?|shorts?|stories|animated?)\b/i, label: "Motion" },
  { re: /\bphotography\b/i, label: "Photography" },
  { re: /\b(copy|script|headline|tagline)\b/i, label: "Copy" },
];

const OBJECTIVES = [
  { re: /\b(awareness|launch|reach)\b/i, label: "Awareness" },
  { re: /\b(waitlist|signup|sign-up|email list)\b/i, label: "Signups" },
  { re: /\b(engagement|community|reply|comment)\b/i, label: "Engagement" },
  { re: /\b(conversion|purchase|sales?|revenue|bookings?)\b/i, label: "Conversion" },
  { re: /\b(retention|reactivation|winback)\b/i, label: "Retention" },
];

const TONES = [
  { re: /\b(editorial|quiet|calm|minimal(ist)?)\b/i, label: "Editorial" },
  { re: /\b(playful|fun|bold|punchy)\b/i, label: "Playful" },
  { re: /\b(warm|friendly|soft|gentle)\b/i, label: "Warm" },
  { re: /\b(conversational|casual)\b/i, label: "Conversational" },
  { re: /\b(premium|luxury|high-end)\b/i, label: "Premium" },
];

const MONTHS = ["january","february","march","april","may","june","july","august","september","october","november","december"];
const MONTH_RE = new RegExp(`\\b(${MONTHS.join("|")})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, "i");
const RELATIVE_RE = /\b(?:in|within)\s+(\d+)\s+(day|days|week|weeks|month|months)\b/i;
const BY_FRIDAY_RE = /\bby\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|eod|end of week|next week|this week)\b/i;
const NUMERIC_DATE_RE = /\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\b/;

const ASPECT_RE = /\b(\d+:\d+|square|vertical|portrait|horizontal)\b/gi;

function parseCount(text) {
  // "10 creatives", "5 posts", "three ads"
  const numericMatch = text.match(/\b(\d{1,3})\s+(creative|creatives|posts?|ads?|variants?|assets?|photos?|images?|reels?|stories|banners?|shots?|hero\s+banners?)\b/i);
  if (numericMatch) {
    const n = parseInt(numericMatch[1], 10);
    const unit = numericMatch[2].toLowerCase().replace(/s$/, "");
    return { value: n, unit: unit + (n === 1 ? "" : "s"), raw: numericMatch[0] };
  }
  const words = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  const wordMatch = text.match(new RegExp(`\\b(${Object.keys(words).join("|")})\\s+(creative|creatives|posts?|ads?|variants?|assets?|photos?|images?|reels?|stories|banners?|shots?)\\b`, "i"));
  if (wordMatch) {
    const n = words[wordMatch[1].toLowerCase()];
    const unit = wordMatch[2].toLowerCase().replace(/s$/, "");
    return { value: n, unit: unit + (n === 1 ? "" : "s"), raw: wordMatch[0] };
  }
  // "a lifestyle set" / "a campaign concept" / "a set of"
  if (/\b(a\s+(set|series|campaign|concept|guide|pack)|lifestyle\s+photography)\b/i.test(text)) {
    return { value: 1, unit: "set", raw: text.match(/\b(a\s+\w+|lifestyle\s+photography)\b/i)?.[0] || "1 set" };
  }
  return null;
}

function parseDeadline(text) {
  let m;
  if ((m = text.match(MONTH_RE))) {
    const month = m[1][0].toUpperCase() + m[1].slice(1, 3).toLowerCase();
    return { value: `${month} ${m[2]}`, raw: m[0] };
  }
  if ((m = text.match(RELATIVE_RE))) {
    return { value: `in ${m[1]} ${m[2]}`, raw: m[0] };
  }
  if ((m = text.match(BY_FRIDAY_RE))) {
    const day = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
    return { value: `By ${day}`, raw: m[0] };
  }
  if ((m = text.match(NUMERIC_DATE_RE))) {
    return { value: m[0], raw: m[0] };
  }
  if (/\b(asap|urgent|rush|this week|end of week|eow|eod)\b/i.test(text)) {
    const raw = text.match(/\b(asap|urgent|rush|this week|end of week|eow|eod)\b/i)[0];
    return { value: raw.toUpperCase(), raw };
  }
  return null;
}

function parseList(text, rules) {
  const hits = [];
  for (const r of rules) {
    if (r.re.test(text) && !hits.includes(r.label)) hits.push(r.label);
  }
  if (!hits.length) return null;
  return { value: hits.join(", "), raw: hits.join(", ") };
}

function parseAspectRatios(text) {
  const matches = text.match(ASPECT_RE);
  if (!matches) return null;
  const uniq = [...new Set(matches.map((s) => s.toLowerCase()))];
  return { value: uniq.join(", "), raw: matches.join(", ") };
}

function parseAudience(text) {
  const m = text.match(/\b(?:for|target(?:ing)?|aimed at)\s+([^,.;\n]{3,60})/i);
  if (!m) return null;
  return { value: m[1].trim(), raw: m[0] };
}

function parseKeyMessage(text) {
  // Heuristic: a sentence starting with "say", "tell", "message:", "cta:"
  const m = text.match(/\b(?:cta|message|hook|headline)\s*[:\-]\s*([^\n.]{3,80})/i);
  if (!m) return null;
  return { value: m[1].trim(), raw: m[0] };
}

function parseBrief(text) {
  if (!text || text.length < 3) {
    return { count: null, deadline: null, format: null, platform: null, objective: null, tone: null, audience: null, keyMessage: null, aspectRatios: null };
  }
  return {
    count: parseCount(text),
    deadline: parseDeadline(text),
    format: parseList(text, FORMATS),
    platform: parseList(text, PLATFORMS),
    objective: parseList(text, OBJECTIVES),
    tone: parseList(text, TONES),
    audience: parseAudience(text),
    keyMessage: parseKeyMessage(text),
    aspectRatios: parseAspectRatios(text),
  };
}

export { parseBrief };
