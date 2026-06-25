// Vercel Serverless Function — api/lookup-flight.js
// Proxies FlightAware AeroAPI calls server-side so the API key
// is never exposed to the browser.
// Deploy by placing this file at /api/lookup-flight.js in your repo root.
// Add FLIGHTAWARE_API_KEY to Vercel Environment Variables.

const IATA_TO_ICAO = {
  "G7":"GJS","OO":"SKW","YX":"RPA","9E":"EDV","MQ":"ENY",
  "OH":"JIA","YV":"ASH","UA":"UAL","AA":"AAL","DL":"DAL",
  "WN":"SWA","B6":"JBU","AS":"ASA","F9":"FFT","NK":"NKS",
  "HA":"HAL","G4":"GGN","SY":"SCX",
};

const TZ_OFFSETS = {
  "America/New_York":-5,"America/Detroit":-5,"America/Toronto":-5,
  "America/Indiana/Indianapolis":-5,"America/Kentucky/Louisville":-5,
  "America/Chicago":-6,"America/Winnipeg":-6,
  "America/Denver":-7,"America/Phoenix":-7,"America/Edmonton":-7,
  "America/Los_Angeles":-8,"America/Vancouver":-8,
  "America/Anchorage":-9,"Pacific/Honolulu":-10,
  "Europe/London":0,"Europe/Paris":1,"Europe/Berlin":1,
  "Asia/Tokyo":9,"Asia/Seoul":9,"Asia/Shanghai":8,
  "Australia/Sydney":10,"Pacific/Auckland":12,
};

function tzOffMs(tz) {
  return (TZ_OFFSETS[tz] || 0) * 3600000;
}

function utcToLocal(iso, tz) {
  if(!iso) return "";
  const ms = new Date(iso).getTime() + tzOffMs(tz);
  const d = new Date(ms);
  return String(d.getUTCHours()).padStart(2,"0")+":"+String(d.getUTCMinutes()).padStart(2,"0");
}

function parseFlightNum(flightNum) {
  const s = flightNum.trim().toUpperCase();
  const m = s.match(/^([A-Z]{2,3}|[A-Z][0-9])\s*([0-9]+)$/);
  if(!m) return { carrier: s, num: "" };
  return { carrier: m[1], num: m[2] };
}

function buildIdents(flightNum) {
  const { carrier, num } = parseFlightNum(flightNum);
  if(!num) return [flightNum.trim().toUpperCase()];
  const icao = IATA_TO_ICAO[carrier] || carrier;
  const idents = new Set();
  idents.add(icao + num);
  idents.add(carrier + num);
  if(carrier === "G7" || icao === "GJS") {
    idents.add("GJS" + num);
    idents.add("UAL" + num);
  }
  return [...idents];
}

module.exports = async function handler(req, res) {
  // Always return JSON even on unexpected crash
  try {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, apikey");

  if(req.method === "OPTIONS") return res.status(200).end();
  if(req.method !== "POST") return res.status(405).json({error:"Method not allowed"});

  const FLIGHTAWARE_API_KEY = process.env.FLIGHTAWARE_API_KEY;
  if(!FLIGHTAWARE_API_KEY) {
    return res.status(500).json({error:"FLIGHTAWARE_API_KEY not configured in Vercel environment variables"});
  }

  const { flightNum, date, depTime } = req.body || {};
  if(!flightNum || !date) {
    return res.status(400).json({error:"Missing flightNum or date"});
  }

  const identsToTry = buildIdents(flightNum);

  const end = new Date(date+"T00:00:00Z");
  end.setUTCDate(end.getUTCDate()+2);
  const endStr = end.toISOString().slice(0,10);

  let best = null;
  let usedIdent = ident;

  for(const tryIdent of identsToTry) {
    const url = `https://aeroapi.flightaware.com/aeroapi/flights/${tryIdent}?start=${date}&end=${endStr}`;
    let faRes;
    try {
      faRes = await fetch(url, {
        headers: {
          "x-apikey": FLIGHTAWARE_API_KEY,
          "Accept": "application/json",
        },
        signal: AbortSignal.timeout(12000),
      });
    } catch(e) {
      console.error(`[lookup-flight] fetch error for ${tryIdent}:`, e.message);
      continue;
    }

    if(!faRes.ok) {
      console.error(`[lookup-flight] FA error ${faRes.status} for ${tryIdent}`);
      // 401/403 = auth issue — no point trying other idents
      if(faRes.status === 401 || faRes.status === 403) {
        const txt = await faRes.text();
        return res.status(502).json({error:`FlightAware auth error ${faRes.status}`, detail: txt.slice(0,200)});
      }
      continue;
    }

    const data = await faRes.json();
    const flights = data?.flights || [];
    if(!flights.length) continue;

    // Prefer flights with actual times
    const withActual = flights.filter(f => f.actual_out||f.actual_off||f.actual_in||f.actual_on);
    const pool = withActual.length ? withActual : flights;

    best = pool[0];
    usedIdent = tryIdent;

    // Match by departure time if multiple candidates
    if(pool.length > 1 && depTime) {
      const tz = pool[0]?.origin?.timezone || "America/Chicago";
      const offMs = tzOffMs(tz);
      const [dh,dm] = depTime.split(":").map(Number);
      const [y,mo,dy] = date.split("-").map(Number);
      const targetUtc = Date.UTC(y,mo-1,dy,dh,dm) - offMs;
      let bestDiff = Infinity;
      for(const f of pool) {
        const s = f.scheduled_out || f.scheduled_off;
        if(!s) continue;
        const diff = Math.abs(new Date(s).getTime() - targetUtc);
        if(diff < bestDiff) { bestDiff = diff; best = f; }
      }
    }
    break;
  }

  if(!best) {
    return res.status(200).json({
      tailNumber:"", actualDepTime:"", actualArrTime:"",
      actualBlockMins:null, notFound:true, triedIdents:identsToTry,
    });
  }

  const originTz = best.origin?.timezone || "America/Chicago";
  const destTz   = best.destination?.timezone || "America/Chicago";

  // Gate times preferred over wheels times
  const depUtc = best.actual_out || best.actual_off || "";
  const arrUtc = best.actual_in  || best.actual_on  || "";

  let blockMins = null;
  if(depUtc && arrUtc) {
    const diff = (new Date(arrUtc).getTime() - new Date(depUtc).getTime()) / 60000;
    if(diff > 0 && diff < 600) blockMins = Math.round(diff);
  }

  console.log(`[lookup-flight] ${usedIdent} → tail:${best.registration} dep:${depUtc} arr:${arrUtc}`);

  return res.status(200).json({
    tailNumber:    best.registration || "",
    actualDepTime: utcToLocal(depUtc, originTz),
    actualArrTime: utcToLocal(arrUtc, destTz),
    actualBlockMins: blockMins,
    cancelled: false,
    ident: usedIdent,
  });
  } catch(e) {
    console.error("[lookup-flight] Unhandled error:", e);
    return res.status(500).json({ error: "Server error: " + e.message });
  }
}
