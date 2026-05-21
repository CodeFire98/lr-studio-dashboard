// =====================================================================
// Linkrunner Media — Marketing-calendar moments
// =====================================================================
//
// Curated list of holidays, festivals, and culturally-relevant observances
// the LinkAI uses to surface proactive post ideas. Tried `date-holidays`
// (npm) first — its IN dataset only ships 6 public holidays and misses
// Diwali, Holi, Eid, Raksha Bandhan, etc., which are exactly the moments
// social-content brands care about. Curated list is more accurate for the
// agency's actual market.
//
// Scope:
//   - All of India's major public + cultural festivals (Hindu, Muslim,
//     Sikh, Christian, regional)
//   - Global / Western marketing moments (Valentine's, Mother's Day,
//     Pride, Black Friday, etc.)
//   - 2026 and 2027 entries hand-dated. Refresh annually — there's a
//     comment marker at the bottom of MOMENTS to flag where to add 2028.
//
// Each entry:
//   date    YYYY-MM-DD
//   name    human-readable
//   country 'IN', 'US', 'GLOBAL' — surface logic filters by brand market
//           plus GLOBAL
//   tags    free-form labels — 'festive', 'religious-hindu', 'national',
//           'consumer', 'cultural-india', 'pride', 'awareness'. The model
//           uses these to decide brand-fit (e.g. a kids' brand probably
//           skips Valentine's but rides Children's Day hard).
//
// Function:
//   getUpcomingMoments({ from, days, country }) — returns moments where
//   country matches the brand's market or is GLOBAL, in [from, from+days].

export const MOMENTS = [
  // ---- 2026 -------------------------------------------------------------
  { date: '2026-01-01', name: "New Year's Day", country: 'GLOBAL', tags: ['festive', 'consumer'] },
  { date: '2026-01-13', name: 'Lohri', country: 'IN', tags: ['festive', 'cultural-india', 'regional-north'] },
  { date: '2026-01-14', name: 'Makar Sankranti / Pongal', country: 'IN', tags: ['festive', 'cultural-india', 'regional-south'] },
  { date: '2026-01-26', name: 'Republic Day', country: 'IN', tags: ['national', 'public-holiday'] },
  { date: '2026-02-14', name: "Valentine's Day", country: 'GLOBAL', tags: ['festive', 'consumer'] },
  { date: '2026-02-17', name: 'Maha Shivratri', country: 'IN', tags: ['festive', 'religious-hindu'] },
  { date: '2026-03-03', name: 'Holi', country: 'IN', tags: ['festive', 'religious-hindu', 'cultural-india'] },
  { date: '2026-03-08', name: "International Women's Day", country: 'GLOBAL', tags: ['awareness', 'social'] },
  { date: '2026-03-20', name: 'Eid al-Fitr', country: 'GLOBAL', tags: ['festive', 'religious-muslim', 'cultural-india'] },
  { date: '2026-04-03', name: 'Good Friday', country: 'GLOBAL', tags: ['religious-christian', 'public-holiday'] },
  { date: '2026-04-05', name: 'Easter', country: 'GLOBAL', tags: ['religious-christian', 'festive'] },
  { date: '2026-04-13', name: 'Baisakhi', country: 'IN', tags: ['festive', 'cultural-india', 'regional-north'] },
  { date: '2026-04-14', name: 'Ambedkar Jayanti', country: 'IN', tags: ['national', 'public-holiday'] },
  { date: '2026-04-22', name: 'Earth Day', country: 'GLOBAL', tags: ['awareness', 'sustainability'] },
  { date: '2026-05-10', name: "Mother's Day", country: 'GLOBAL', tags: ['festive', 'consumer'] },
  { date: '2026-05-27', name: 'Eid al-Adha', country: 'GLOBAL', tags: ['festive', 'religious-muslim'] },
  { date: '2026-06-01', name: 'Pride Month begins', country: 'GLOBAL', tags: ['awareness', 'social', 'pride'] },
  { date: '2026-06-05', name: 'World Environment Day', country: 'GLOBAL', tags: ['awareness', 'sustainability'] },
  { date: '2026-06-21', name: "Father's Day", country: 'GLOBAL', tags: ['festive', 'consumer'] },
  { date: '2026-08-15', name: 'Independence Day', country: 'IN', tags: ['national', 'public-holiday'] },
  { date: '2026-08-26', name: 'Janmashtami', country: 'IN', tags: ['festive', 'religious-hindu'] },
  { date: '2026-08-28', name: 'Raksha Bandhan', country: 'IN', tags: ['festive', 'cultural-india', 'family'] },
  { date: '2026-09-04', name: 'Onam', country: 'IN', tags: ['festive', 'cultural-india', 'regional-south'] },
  { date: '2026-09-14', name: 'Ganesh Chaturthi', country: 'IN', tags: ['festive', 'religious-hindu', 'cultural-india'] },
  { date: '2026-10-02', name: 'Gandhi Jayanti', country: 'IN', tags: ['national', 'public-holiday'] },
  { date: '2026-10-10', name: 'World Mental Health Day', country: 'GLOBAL', tags: ['awareness', 'wellness'] },
  { date: '2026-10-19', name: 'Karwa Chauth', country: 'IN', tags: ['festive', 'cultural-india'] },
  { date: '2026-10-20', name: 'Dussehra', country: 'IN', tags: ['festive', 'religious-hindu', 'cultural-india'] },
  { date: '2026-10-31', name: 'Halloween', country: 'GLOBAL', tags: ['festive', 'consumer'] },
  { date: '2026-11-08', name: 'Diwali', country: 'IN', tags: ['festive', 'religious-hindu', 'cultural-india', 'consumer'] },
  { date: '2026-11-14', name: "Children's Day (IN)", country: 'IN', tags: ['festive', 'family'] },
  { date: '2026-11-24', name: 'Guru Nanak Jayanti', country: 'IN', tags: ['festive', 'religious-sikh', 'public-holiday'] },
  { date: '2026-11-27', name: 'Black Friday', country: 'GLOBAL', tags: ['consumer', 'commerce'] },
  { date: '2026-11-30', name: 'Cyber Monday', country: 'GLOBAL', tags: ['consumer', 'commerce'] },
  { date: '2026-12-25', name: 'Christmas Day', country: 'GLOBAL', tags: ['festive', 'religious-christian', 'consumer'] },
  { date: '2026-12-31', name: "New Year's Eve", country: 'GLOBAL', tags: ['festive'] },

  // ---- 2027 -------------------------------------------------------------
  // Dates from official Indian government calendars + standard global
  // observances. Lunar holidays (Diwali, Holi, Eid, etc.) move year-to-year
  // and need to be refreshed annually — keep this list current.
  { date: '2027-01-01', name: "New Year's Day", country: 'GLOBAL', tags: ['festive', 'consumer'] },
  { date: '2027-01-13', name: 'Lohri', country: 'IN', tags: ['festive', 'cultural-india', 'regional-north'] },
  { date: '2027-01-14', name: 'Makar Sankranti / Pongal', country: 'IN', tags: ['festive', 'cultural-india', 'regional-south'] },
  { date: '2027-01-26', name: 'Republic Day', country: 'IN', tags: ['national', 'public-holiday'] },
  { date: '2027-02-14', name: "Valentine's Day", country: 'GLOBAL', tags: ['festive', 'consumer'] },
  { date: '2027-03-08', name: "International Women's Day", country: 'GLOBAL', tags: ['awareness', 'social'] },
  { date: '2027-03-23', name: 'Holi', country: 'IN', tags: ['festive', 'religious-hindu', 'cultural-india'] },
  { date: '2027-03-26', name: 'Good Friday', country: 'GLOBAL', tags: ['religious-christian', 'public-holiday'] },
  { date: '2027-03-28', name: 'Easter', country: 'GLOBAL', tags: ['religious-christian', 'festive'] },
  { date: '2027-04-14', name: 'Ambedkar Jayanti', country: 'IN', tags: ['national', 'public-holiday'] },
  { date: '2027-04-22', name: 'Earth Day', country: 'GLOBAL', tags: ['awareness', 'sustainability'] },
  // Eid dates per Saudi moon-sighting — verify each year.
  { date: '2027-03-10', name: 'Eid al-Fitr', country: 'GLOBAL', tags: ['festive', 'religious-muslim', 'cultural-india'] },
  { date: '2027-05-17', name: 'Eid al-Adha', country: 'GLOBAL', tags: ['festive', 'religious-muslim'] },
  { date: '2027-05-09', name: "Mother's Day", country: 'GLOBAL', tags: ['festive', 'consumer'] },
  { date: '2027-06-01', name: 'Pride Month begins', country: 'GLOBAL', tags: ['awareness', 'social', 'pride'] },
  { date: '2027-06-05', name: 'World Environment Day', country: 'GLOBAL', tags: ['awareness', 'sustainability'] },
  { date: '2027-06-20', name: "Father's Day", country: 'GLOBAL', tags: ['festive', 'consumer'] },
  { date: '2027-08-15', name: 'Independence Day', country: 'IN', tags: ['national', 'public-holiday'] },
  { date: '2027-08-26', name: 'Onam', country: 'IN', tags: ['festive', 'cultural-india', 'regional-south'] },
  { date: '2027-09-03', name: 'Ganesh Chaturthi', country: 'IN', tags: ['festive', 'religious-hindu', 'cultural-india'] },
  { date: '2027-10-02', name: 'Gandhi Jayanti', country: 'IN', tags: ['national', 'public-holiday'] },
  { date: '2027-10-09', name: 'Dussehra', country: 'IN', tags: ['festive', 'religious-hindu', 'cultural-india'] },
  { date: '2027-10-29', name: 'Diwali', country: 'IN', tags: ['festive', 'religious-hindu', 'cultural-india', 'consumer'] },
  { date: '2027-10-31', name: 'Halloween', country: 'GLOBAL', tags: ['festive', 'consumer'] },
  { date: '2027-11-14', name: "Children's Day (IN)", country: 'IN', tags: ['festive', 'family'] },
  { date: '2027-11-26', name: 'Black Friday', country: 'GLOBAL', tags: ['consumer', 'commerce'] },
  { date: '2027-11-29', name: 'Cyber Monday', country: 'GLOBAL', tags: ['consumer', 'commerce'] },
  { date: '2027-12-25', name: 'Christmas Day', country: 'GLOBAL', tags: ['festive', 'religious-christian', 'consumer'] },
  { date: '2027-12-31', name: "New Year's Eve", country: 'GLOBAL', tags: ['festive'] },

  // ---- ADD 2028 entries here when 2027 is half-elapsed -----------------
];

export function getUpcomingMoments({ from, days = 30, country = 'IN' } = {}) {
  const start = from ? new Date(from) : new Date();
  if (Number.isNaN(start.getTime())) return [];
  const startMs = startOfDayMs(start);
  const endMs = startMs + days * 24 * 60 * 60 * 1000;

  const matches = [];
  for (const moment of MOMENTS) {
    if (moment.country !== 'GLOBAL' && moment.country !== country) continue;
    const dMs = startOfDayMs(new Date(moment.date));
    if (Number.isNaN(dMs)) continue;
    if (dMs < startMs || dMs > endMs) continue;
    matches.push({ ...moment, daysAway: Math.round((dMs - startMs) / (24 * 60 * 60 * 1000)) });
  }
  matches.sort((a, b) => a.date.localeCompare(b.date));
  return matches;
}

function startOfDayMs(d) {
  const local = new Date(d);
  local.setHours(0, 0, 0, 0);
  return local.getTime();
}
