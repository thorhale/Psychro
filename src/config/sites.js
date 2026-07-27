/**
 * Stream Data Centers site catalog + branding strings.
 *
 * Pure data — updating the campus list or renaming the product touches only this
 * file. Elevations are metro-level approximations (ft); fine-tune per campus pad
 * in the hall profile.
 */

export const BRAND = {
  company: 'STREAM',
  companySub: 'DATA CENTERS',
  product: 'Hall Environment Planner',
  tagline: 'Critical Engineering · ASHRAE TC 9.9',
  /** Navy → teal palette used by the export header and footer. */
  navy: '#1a3a5c',
  navyDark: '#13263a',
  teal: '#00a9ce',
};

export const STREAM_SITES_BUILTIN = [
  // Alabama
  { state: 'Alabama', city: 'Huntsville', code: 'HSVA', elevFt: 640 },
  // Arizona
  { state: 'Arizona', city: 'Goodyear', code: 'PHX', elevFt: 1066 },
  // California
  { state: 'California', city: 'Newark', code: 'Santa Clara V', elevFt: 20 },
  { state: 'California', city: 'Santa Clara', code: 'Santa Clara I–II', elevFt: 75 },
  { state: 'California', city: 'Santa Clara', code: 'Santa Clara III', elevFt: 75 },
  { state: 'California', city: 'Santa Clara', code: 'Santa Clara IV', elevFt: 75 },
  { state: 'California', city: 'Santa Clara', code: 'Santa Clara VI', elevFt: 75 },
  // Colorado
  { state: 'Colorado', city: 'Westminster', code: 'DEN', elevFt: 5380 },
  // Georgia
  { state: 'Georgia', city: 'Atlanta', code: 'ATL', elevFt: 1050 },
  { state: 'Georgia', city: 'Atlanta', code: 'ATLB', elevFt: 1050 },
  { state: 'Georgia', city: 'Atlanta', code: 'ATLC', elevFt: 1050 },
  // Illinois
  { state: 'Illinois', city: 'Elk Grove Village', code: 'ORDA', elevFt: 660 },
  { state: 'Illinois', city: 'Elk Grove Village', code: 'ORDB', elevFt: 660 },
  { state: 'Illinois', city: 'Elk Grove Village', code: 'ORDC', elevFt: 660 },
  // Minnesota
  { state: 'Minnesota', city: 'Chaska', code: 'Minneapolis I', elevFt: 720 },
  { state: 'Minnesota', city: 'Chaska', code: 'MSPA', elevFt: 720 },
  // Ohio
  { state: 'Ohio', city: 'Columbus', code: 'CMHA', elevFt: 900 },
  // Texas
  { state: 'Texas', city: 'Austin', code: 'Austin I', elevFt: 505 },
  { state: 'Texas', city: 'Dallas', code: 'DFW I', elevFt: 430 },
  { state: 'Texas', city: 'Dallas', code: 'DFW II', elevFt: 430 },
  { state: 'Texas', city: 'Dallas', code: 'DFWD', elevFt: 430 },
  { state: 'Texas', city: 'Dallas', code: 'DFWE', elevFt: 430 },
  { state: 'Texas', city: 'Dallas', code: 'DFWF', elevFt: 430 },
  { state: 'Texas', city: 'Garland', code: 'DFWA', elevFt: 560 },
  { state: 'Texas', city: 'Plano', code: 'DFW III (Legacy Business Park)', elevFt: 660 },
  { state: 'Texas', city: 'Plano', code: 'DFW VI (Legacy Business Park)', elevFt: 660 },
  { state: 'Texas', city: 'Richardson', code: 'DFW IV', elevFt: 600 },
  { state: 'Texas', city: 'Richardson', code: 'DFW V', elevFt: 600 },
  { state: 'Texas', city: 'San Antonio', code: 'San Antonio I', elevFt: 650 },
  { state: 'Texas', city: 'San Antonio', code: 'SATB', elevFt: 650 },
  { state: 'Texas', city: 'The Woodlands', code: 'IAHA', elevFt: 130 },
  { state: 'Texas', city: 'Wilmer', code: 'DFWB', elevFt: 430 },
  { state: 'Texas', city: 'Wilmer', code: 'DFWC', elevFt: 430 },
  // Virginia
  { state: 'Virginia', city: 'Ashburn', code: 'IAD', elevFt: 300 },
  { state: 'Virginia', city: 'Chantilly', code: 'NOVA I & II', elevFt: 300 },
];

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
 * Built-in + user-added sites, decorated and sorted for the picker
 * (State → City → Site code).
 * @param {Array<{state:string, city:string, code?:string, elevFt?:number, siteName?:string}>} customSites
 *   user-added sites (persisted separately)
 */
export function allSites(customSites = []) {
  /** @type {Array<{state:string, city:string, code?:string, elevFt?:number, siteName?:string}>} */
  const merged = [...STREAM_SITES_BUILTIN, ...customSites];
  return merged
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
