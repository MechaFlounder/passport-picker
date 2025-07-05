// functions/update.js

// This contains the logic from your original update-data.js file.
// It is configured to run on a schedule.

const PASSPORT_LIST = { "Afghanistan": "AF", "Albania": "AL", "Algeria": "DZ", "Andorra": "AD", "Angola": "AO", "Antigua and Barbuda": "AG", "Argentina": "AR", "Armenia": "AM", "Australia": "AU", "Austria": "AT", "Azerbaijan": "AZ", "Bahamas": "BS", "Bahrain": "BH", "Bangladesh": "BD", "Barbados": "BB", "Belarus": "BY", "Belgium": "BE", "Belize": "BZ", "Benin": "BJ", "Bhutan": "BT", "Bolivia": "BO", "Bosnia and Herzegovina": "BA", "Botswana": "BW", "Brazil": "BR", "Brunei": "BN", "Bulgaria": "BG", "Burkina Faso": "BF", "Burundi": "BI", "Cambodia": "KH", "Cameroon": "CM", "Canada": "CA", "Cape Verde": "CV", "Central African Republic": "CF", "Chad": "TD", "Chile": "CL", "China": "CN", "Colombia": "CO", "Comoros": "KM", "Congo": "CG", "Congo (Dem. Rep.)": "CD", "Costa Rica": "CR", "Cote d'Ivoire": "CI", "Croatia": "HR", "Cuba": "CU", "Cyprus": "CY", "Czech Republic": "CZ", "Denmark": "DK", "Djibouti": "DJ", "Dominica": "DM", "Dominican Republic": "DO", "Ecuador": "EC", "Egypt": "EG", "El Salvador": "SV", "Equatorial Guinea": "GQ", "Eritrea": "ER", "Estonia": "EE", "Eswatini": "SZ", "Ethiopia": "ET", "Fiji": "FJ", "Finland": "FI", "France": "FR", "Gabon": "GA", "Gambia": "GM", "Georgia": "GE", "Germany": "DE", "Ghana": "GH", "Greece": "GR", "Grenada": "GD", "Guatemala": "GT", "Guinea": "GN", "Guinea-Bissau": "GW", "Guyana": "GY", "Haiti": "HT", "Honduras": "HN", "Hong Kong": "HK", "Hungary": "HU", "Iceland": "IS", "India": "IN", "Indonesia": "ID", "Iran": "IR", "Iraq": "IQ", "Ireland": "IE", "Israel": "IL", "Italy": "IT", "Jamaica": "JM", "Japan": "JP", "Jordan": "JO", "Kazakhstan": "KZ", "Kenya": "KE", "Kiribati": "KI", "Kosovo": "XK", "Kuwait": "KW", "Kyrgyzstan": "KG", "Laos": "LA", "Latvia": "LV", "Lebanon": "LB", "Lesotho": "LS", "Liberia": "LR", "Libya": "LY", "Liechtenstein": "LI", "Lithuania": "LT", "Luxembourg": "LU", "Macau": "MO", "Madagascar": "MG", "Malawi": "MW", "Malaysia": "MY", "Maldives": "MV", "Mali": "ML", "Malta": "MT", "Marshall Islands": "MH", "Mauritania": "MR", "Mauritius": "MU", "Mexico": "MX", "Micronesia": "FM", "Moldova": "MD", "Monaco": "MC", "Mongolia": "MN", "Montenegro": "ME", "Morocco": "MA", "Mozambique": "MZ", "Myanmar": "MM", "Namibia": "NA", "Nauru": "NR", "Nepal": "NP", "Netherlands": "NL", "New Zealand": "NZ", "Nicaragua": "NI", "Niger": "NE", "Nigeria": "NG", "North Korea": "KP", "North Macedonia": "MK", "Norway": "NO", "Oman": "OM", "Pakistan": "PK", "Palau": "PW", "Palestinian Territories": "PS", "Panama": "PA", "Papua New Guinea": "PG", "Paraguay": "PY", "Peru": "PE", "Philippines": "PH", "Poland": "PL", "Portugal": "PT", "Qatar": "QA", "Romania": "RO", "Russian Federation": "RU", "Rwanda": "RW", "Saint Kitts and Nevis": "KN", "Saint Lucia": "LC", "Samoa": "WS", "San Marino": "SM", "Sao Tome and Principe": "ST", "Saudi Arabia": "SA", "Senegal": "SN", "Serbia": "RS", "Seychelles": "SC", "Sierra Leone": "SL", "Singapore": "SG", "Slovakia": "SK", "Slovenia": "SI", "Solomon Islands": "SB", "Somalia": "SO", "South Africa": "ZA", "South Korea": "KR", "South Sudan": "SS", "Spain": "ES", "Sri Lanka": "LK", "St. Vincent and the Grenadines": "VC", "Sudan": "SD", "Suriname": "SR", "Sweden": "SE", "Switzerland": "CH", "Syria": "SY", "Taiwan": "TW", "Tajikistan": "TJ", "Tanzania": "TZ", "Thailand": "TH", "Timor-Leste": "TL", "Togo": "TG", "Tonga": "TO", "Trinidad and Tobago": "TT", "Tunisia": "TN", "Türkiye": "TR", "Turkmenistan": "TM", "Tuvalu": "TV", "Uganda": "UG", "Ukraine": "UA", "United Arab Emirates": "AE", "United Kingdom": "GB", "United States of America": "US", "Uruguay": "UY", "Uzbekistan": "UZ", "Vanuatu": "VU", "Vatican City": "VA", "Venezuela": "VE", "Viet Nam": "VN", "Yemen": "YE", "Zambia": "ZM", "Zimbabwe": "ZW" };
const DESTINATION_LIST = { ...PASSPORT_LIST }; // Assuming destinations are the same as passports
const REQUEST_DELAY = 200; // ms delay between requests to avoid rate limiting

async function fetchSingleVisaStatus(apiKey, passportCode, destCode) {
    const url = `https://visa-requirement.p.rapidapi.com/?passport=${passportCode}&destination=${destCode}`;
    const options = {
        method: 'GET',
        headers: {
            'X-RapidAPI-Key': apiKey,
            'X-RapidAPI-Host': 'visa-requirement.p.rapidapi.com'
        }
    };
    try {
        const response = await fetch(url, options);
        if (!response.ok) {
            console.error(`API error for ${passportCode}->${destCode}: ${response.status}`);
            return { status: 'na', stay: 0, error: `API Error: ${response.status}` };
        }
        const data = await response.json();
        return {
            status: data.status || 'na',
            stay: parseInt(data.stay_of) || 0,
            visa: data.visa || 'No data'
        };
    } catch (error) {
        console.error(`Fetch failed for ${passportCode}->${destCode}:`, error);
        return { status: 'na', stay: 0, error: 'Fetch failed' };
    }
}

// This is the function that Cloudflare will run on a schedule.
// The schedule is defined in the Cloudflare Pages dashboard under Cron Triggers.
// Example: "0 0 1 * *" runs at midnight on the first day of every month.
export async function onScheduled(context) {
    console.log("Starting scheduled visa data update...");
    const apiKey = context.env.RAPIDAPI_KEY;
    if (!apiKey) {
        console.error("RAPIDAPI_KEY environment variable not set. Aborting update.");
        return;
    }

    let allData = {};
    try {
        // Try to get existing data from R2 to avoid re-fetching everything
        const existingObject = await context.env.VISA_DATA_BUCKET.get('visa-data.json');
        if (existingObject) {
            allData = await existingObject.json();
            console.log("Loaded existing data from R2.");
        }
    } catch (e) {
        console.error("Could not retrieve or parse existing data from R2. Starting fresh.", e);
        allData = {};
    }

    const passportCodes = Object.values(PASSPORT_LIST);
    const destinationCodes = Object.values(DESTINATION_LIST);

    for (const passportCode of passportCodes) {
        // Basic check to see if data for this passport seems complete
        if (allData[passportCode] && Object.keys(allData[passportCode]).length >= destinationCodes.length) {
            console.log(`Data for ${passportCode} already complete. Skipping.`);
            continue;
        }

        console.log(`Fetching data for ${passportCode} passport...`);
        allData[passportCode] = allData[passportCode] || {};

        for (const destCode of destinationCodes) {
            if (passportCode === destCode) {
                allData[passportCode][destCode] = { status: 'citizen', stay: Infinity, visa: 'Citizen' };
                continue;
            }
            // Only fetch if not already present
            if (!allData[passportCode][destCode]) {
                 const statusData = await fetchSingleVisaStatus(apiKey, passportCode, destCode);
                 allData[passportCode][destCode] = statusData;
                 await new Promise(resolve => setTimeout(resolve, REQUEST_DELAY));
            }
        }

        try {
            // Save progress to R2 after each passport is completed
            await context.env.VISA_DATA_BUCKET.put('visa-data.json', JSON.stringify(allData, null, 2));
            console.log(`Saved progress for ${passportCode} to R2.`);
        } catch (writeError) {
            console.error(`Failed to save progress for ${passportCode} to R2:`, writeError);
        }
    }
    
    console.log(`[${new Date().toISOString()}] Visa data update complete. Final data saved to R2.`);
}
