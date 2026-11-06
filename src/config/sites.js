/**
 * Site list helpers.
 *
 * The app ships NO sites. Every location in the picker is one somebody added
 * on this device (the "+ Add city" form, or a loaded save file), and it lives
 * only in this device's storage. This file used to carry one company's whole
 * campus list, codes and all, so anyone the app was shared with opened it to
 * somebody else's fleet. A planner handed to a stranger has to open empty.
 */

const ST_ABBR = {
  Alabama: 'AL', Arizona: 'AZ', Arkansas: 'AR', California: 'CA', Colorado: 'CO',
  Connecticut: 'CT', Delaware: 'DE', Florida: 'FL', Georgia: 'GA', Idaho: 'ID',
  Illinois: 'IL', Indiana: 'IN', Iowa: 'IA', Kansas: 'KS', Kentucky: 'KY',
  Louisiana: 'LA', Maine: 'ME', Maryland: 'MD', Massachusetts: 'MA', Michigan: 'MI',
  Minnesota: 'MN', Mississippi: 'MS', Missouri: 'MO', Montana: 'MT', Nebraska: 'NE',
  Nevada: 'NV', 'New Hampshire': 'NH', 'New Jersey': 'NJ', 'New Mexico': 'NM',
  'New York': 'NY', 'North Carolina': 'NC', 'North Dakota': 'ND', Ohio: 'OH',
  Oklahoma: 'OK', Oregon: 'OR', Pennsylvania: 'PA', 'Rhode Island': 'RI',
  'South Carolina': 'SC', 'South Dakota': 'SD', Tennessee: 'TN', Texas: 'TX',
  Utah: 'UT', Vermont: 'VT', Virginia: 'VA', Washington: 'WA',
  'West Virginia': 'WV', Wisconsin: 'WI', Wyoming: 'WY',
};

/** Two-letter state abbreviation, with a best-effort fallback. */
export function stAbbr(s) {
  return ST_ABBR[s] || (s || '').slice(0, 2).toUpperCase();
}

/**
 * The sites saved on this device, decorated and sorted for the picker
 * (State → City → Site code).
 * @param {Array<{state:string, city:string, code?:string, elevFt?:number, siteName?:string}>} customSites
 *   user-added sites (persisted separately)
 */
export function allSites(customSites = []) {
  /** @type {Array<{state:string, city:string, code?:string, elevFt?:number, siteName?:string}>} */
  return [...customSites]
    .map((s) => ({
      ...s,
      siteName: s.siteName || `${s.city}, ${stAbbr(s.state)}`,
      label: `${s.code} — ${s.city}, ${s.state}`,
    }))
    .sort(
      (a, b) =>
        a.state.localeCompare(b.state) ||
        a.city.localeCompare(b.city) ||
        String(a.code).localeCompare(String(b.code)),
    );
}
