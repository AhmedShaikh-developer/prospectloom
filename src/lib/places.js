// City presets for the Lead engine. Each entry is searched as one area per business type.
const US = `New York, NY|Los Angeles, CA|Chicago, IL|Houston, TX|Phoenix, AZ|Philadelphia, PA|San Antonio, TX|San Diego, CA|Dallas, TX|Austin, TX
San Jose, CA|Jacksonville, FL|Fort Worth, TX|Columbus, OH|Indianapolis, IN|Charlotte, NC|San Francisco, CA|Seattle, WA|Denver, CO|Washington, DC
Nashville, TN|Oklahoma City, OK|El Paso, TX|Boston, MA|Portland, OR|Las Vegas, NV|Detroit, MI|Memphis, TN|Louisville, KY|Baltimore, MD
Milwaukee, WI|Albuquerque, NM|Tucson, AZ|Fresno, CA|Sacramento, CA|Mesa, AZ|Kansas City, MO|Atlanta, GA|Omaha, NE|Colorado Springs, CO
Raleigh, NC|Long Beach, CA|Virginia Beach, VA|Miami, FL|Oakland, CA|Minneapolis, MN|Tulsa, OK|Bakersfield, CA|Wichita, KS|Arlington, TX
Aurora, CO|Tampa, FL|New Orleans, LA|Cleveland, OH|Honolulu, HI|Anaheim, CA|Lexington, KY|Stockton, CA|Corpus Christi, TX|Henderson, NV
Riverside, CA|Newark, NJ|Saint Paul, MN|Santa Ana, CA|Cincinnati, OH|Irvine, CA|Orlando, FL|Pittsburgh, PA|St. Louis, MO|Greensboro, NC
Jersey City, NJ|Anchorage, AK|Lincoln, NE|Plano, TX|Durham, NC|Buffalo, NY|Chandler, AZ|Chula Vista, CA|Toledo, OH|Madison, WI
Gilbert, AZ|Reno, NV|Fort Wayne, IN|North Las Vegas, NV|St. Petersburg, FL|Lubbock, TX|Irving, TX|Laredo, TX|Winston-Salem, NC|Chesapeake, VA
Glendale, AZ|Garland, TX|Scottsdale, AZ|Norfolk, VA|Boise, ID|Fremont, CA|Spokane, WA|Salt Lake City, UT|Baton Rouge, LA|Richmond, VA`
  .split(/[|\n]/).map((c) => `${c.trim()}, USA`);

export const PRESETS = {
  us50: { label: 'US — 50 largest cities', cities: US.slice(0, 50) },
  us100: { label: 'US — 100 largest cities', cities: US },
  uk: { label: 'UK — 15 cities', cities: ['London', 'Manchester', 'Birmingham', 'Leeds', 'Glasgow', 'Liverpool', 'Bristol', 'Edinburgh', 'Sheffield', 'Newcastle upon Tyne', 'Nottingham', 'Leicester', 'Cardiff', 'Belfast', 'Brighton'].map((c) => `${c}, United Kingdom`) },
  canada: { label: 'Canada — 10 cities', cities: ['Toronto', 'Montreal', 'Vancouver', 'Calgary', 'Edmonton', 'Ottawa', 'Winnipeg', 'Quebec City', 'Hamilton', 'Mississauga'].map((c) => `${c}, Canada`) },
  australia: { label: 'Australia — 7 cities', cities: ['Sydney', 'Melbourne', 'Brisbane', 'Perth', 'Adelaide', 'Gold Coast', 'Canberra'].map((c) => `${c}, Australia`) },
  germany: { label: 'Germany — 14 cities', cities: ['Berlin', 'Hamburg', 'Munich', 'Cologne', 'Frankfurt', 'Stuttgart', 'Düsseldorf', 'Leipzig', 'Dortmund', 'Essen', 'Bremen', 'Dresden', 'Hanover', 'Nuremberg'].map((c) => `${c}, Germany`) },
  uae: { label: 'UAE — 3 cities', cities: ['Dubai', 'Abu Dhabi', 'Sharjah'].map((c) => `${c}, United Arab Emirates`) },
};
