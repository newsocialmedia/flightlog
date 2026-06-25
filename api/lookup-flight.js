module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if(req.method === "OPTIONS") return res.status(200).end();

  const FLIGHTAWARE_API_KEY = process.env.FLIGHTAWARE_API_KEY;
  if(!FLIGHTAWARE_API_KEY) {
    return res.status(500).json({ error: "FLIGHTAWARE_API_KEY not set in Vercel env vars" });
  }

  let body = {};
  try { body = req.body || {}; } catch(e) {}

  const { flightNum = "", date = "", depTime = "" } = body;
  if(!flightNum || !date) {
    return res.status(400).json({ error: "Missing flightNum or date", received: body });
  }

  // IATA to ICAO
  const MAP = {"G7":"GJS","OO":"SKW","YX":"RPA","9E":"EDV","UA":"UAL","AA":"AAL","DL":"DAL","WN":"SWA","B6":"JBU","AS":"ASA"};
  const s = flightNum.trim().toUpperCase();
  const m = s.match(/^([A-Z]{2,3}|[A-Z]\d)\s*(\d+)$/);
  const carrier = m ? m[1] : "";
  const num = m ? m[2] : "";
  const icao = (carrier && MAP[carrier]) ? MAP[carrier] : carrier;
  const ident = icao + num;

  const identsToTry = [...new Set([ident, carrier+num, "GJS"+num, "UAL"+num].filter(x=>x&&x.length>2))];

  const endDate = new Date(date+"T00:00:00Z");
  endDate.setUTCDate(endDate.getUTCDate()+2);
  const endStr = endDate.toISOString().slice(0,10);

  let lastError = "";
  for(const tryIdent of identsToTry) {
    let faRes;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 12000);
      faRes = await fetch(
        `https://aeroapi.flightaware.com/aeroapi/flights/${tryIdent}?start=${date}&end=${endStr}`,
        { headers: {"x-apikey": FLIGHTAWARE_API_KEY, "Accept": "application/json"}, signal: ctrl.signal }
      );
      clearTimeout(t);
    } catch(e) {
      lastError = `fetch error: ${e.message}`;
      continue;
    }

    if(!faRes.ok) {
      const txt = await faRes.text().catch(()=>"");
      lastError = `FA ${faRes.status}: ${txt.slice(0,200)}`;
      if(faRes.status===401||faRes.status===403) {
        return res.status(200).json({ error: lastError, tailNumber:"", actualDepTime:"", actualArrTime:"", actualBlockMins:null });
      }
      continue;
    }

    let data;
    try { data = await faRes.json(); } catch(e) { lastError="bad json"; continue; }

    const flights = data?.flights || [];
    if(!flights.length) { lastError=`no flights for ${tryIdent}`; continue; }

    const pool = flights.filter(f=>f.actual_out||f.actual_off||f.actual_in||f.actual_on);
    const best = pool.length ? pool[0] : flights[0];

    const TZ = {"America/New_York":-5,"America/Chicago":-6,"America/Denver":-7,"America/Los_Angeles":-8,"America/Phoenix":-7,"America/Anchorage":-9};
    function toLocal(iso, tz) {
      if(!iso) return "";
      const off = (TZ[tz]||0)*3600000;
      const d = new Date(new Date(iso).getTime()+off);
      return String(d.getUTCHours()).padStart(2,"0")+":"+String(d.getUTCMinutes()).padStart(2,"0");
    }

    const oTz = best.origin?.timezone||"America/Chicago";
    const dTz = best.destination?.timezone||"America/Chicago";
    const depUtc = best.actual_out||best.actual_off||"";
    const arrUtc = best.actual_in||best.actual_on||"";
    let blockMins = null;
    if(depUtc&&arrUtc){
      const diff=(new Date(arrUtc)-new Date(depUtc))/60000;
      if(diff>0&&diff<600) blockMins=Math.round(diff);
    }

    return res.status(200).json({
      tailNumber: best.registration||"",
      actualDepTime: toLocal(depUtc,oTz),
      actualArrTime: toLocal(arrUtc,dTz),
      actualBlockMins: blockMins,
      cancelled: false,
      ident: tryIdent,
    });
  }

  return res.status(200).json({
    tailNumber:"", actualDepTime:"", actualArrTime:"", actualBlockMins:null,
    notFound:true, lastError, triedIdents:identsToTry,
  });
};
