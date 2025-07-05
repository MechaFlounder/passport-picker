// functions/api/visa-data.js

// This function now reads the data from the R2 bucket.
export async function onRequestPost(context) {
  try {
    // Get the passports array from the request body
    const { passports } = await context.request.json();

    if (!passports || !Array.isArray(passports)) {
      return new Response(JSON.stringify({ error: 'Missing or invalid passports array' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    
    // Get the visa-data.json file from the R2 bucket
    const object = await context.env.VISA_DATA_BUCKET.get('visa-data.json');

    if (object === null) {
      return new Response(JSON.stringify({ error: 'Visa data file not found in storage.' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const allData = await object.json();

    const requestedData = {};
    passports.forEach(code => {
      if (allData[code]) {
        requestedData[code] = allData[code];
      }
    });

    // Return the filtered data
    return new Response(JSON.stringify(requestedData), {
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Error in visa-data function:', error);
    return new Response(JSON.stringify({ error: 'Internal Server Error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
