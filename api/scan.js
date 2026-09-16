const OpenAI = require('openai');

const UA = 'Mozilla/5.0 (compatible; TrendProductEngine/1.0)';
const TIMEOUT_MS = 3000;

function clean(value = '') {
  return String(value).replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
}
function rssItems(xml, limit = 10) {
  const items = [], matches = String(xml).match(/<item[\s\S]*?<\/item>/gi) || [];
  for (const block of matches.slice(0, limit)) {
    const title = clean((block.match(/<title>([\s\S]*?)<\/title>/i) || [, ''])[1]);
    const link = clean((block.match(/<link>([\s\S]*?)<\/link>/i) || [, ''])[1]);
    const pubDate = clean((block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i) || [, ''])[1]);
    if (title) items.push({ title, link, pubDate });
  }
  return items;
}
async function fetchText(url, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': UA, ...headers } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally { clearTimeout(timer); }
}
async function safe(fn) { try { return await fn(); } catch (e) { console.error(e?.message || e); return []; } }

async function autocomplete(prefix) {
  return safe(async () => {
    const raw = await fetchText(`https://suggestqueries.google.com/complete/search?client=firefox&hl=en-GB&q=${encodeURIComponent(prefix)}`, { Accept: 'application/json,text/plain,*/*', 'Accept-Language': 'en-GB,en;q=0.9' });
    const data = JSON.parse(raw);
    return Array.isArray(data?.[1]) ? data[1].map(x => typeof x === 'string' ? x : x?.[0]).filter(Boolean).slice(0, 8) : [];
  });
}
async function searchIntentDiscovery() {
  const prefixes = ['how to','how do I','how can I','help with','alternative to','replacement for','best way to','problem with','why does','is there a way to','what can I use instead of'];
  const batches = await Promise.all(prefixes.map(async prefix => ({ prefix, suggestions: await autocomplete(prefix) })));
  const rows = [];
  for (const b of batches) for (const query of b.suggestions) rows.push({ query, prefix: b.prefix, source: 'Google Autocomplete', signalType: 'search-intent' });
  return Array.from(new Map(rows.map(x => [x.query.toLowerCase(), x])).values()).slice(0, 70);
}
async function googleTrends() {
  return safe(async () => rssItems(await fetchText('https://trends.google.com/trending/rss?geo=GB'), 20).map(x => ({ ...x, source: 'Google Trends', signalType: 'trending search' })));
}
async function googleNews(query, limit = 6) {
  return safe(async () => rssItems(await fetchText(`https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-GB&gl=GB&ceid=GB:en`), limit).map(x => ({ ...x, source: 'Google News', signalType: 'review/complaint search' })));
}
async function redditSearch(query) {
  return safe(async () => {
    const r = await fetch(`https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=relevance&limit=8`, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (!r.ok) return [];
    const d = await r.json();
    return (d?.data?.children || []).map(x => ({ title: x?.data?.title || '', link: x?.data?.permalink ? `https://www.reddit.com${x.data.permalink}` : '', pubDate: x?.data?.created_utc ? new Date(x.data.created_utc * 1000).toISOString() : '', source: 'Reddit', signalType: 'customer discussion' })).filter(x => x.title);
  });
}
async function youtubeSearch(query, limit = 6) {
  return safe(async () => {
    const html = await fetchText(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`, { 'Accept-Language': 'en-GB,en;q=0.9' });
    const marker = 'var ytInitialData = ', start = html.indexOf(marker);
    if (start < 0) return [];
    const jsonStart = start + marker.length, end = html.indexOf(';var ytInitialPlayerResponse', jsonStart), scriptEnd = html.indexOf('</script>', jsonStart);
    const raw = html.slice(jsonStart, end > jsonStart ? end : scriptEnd).trim().replace(/;$/, '');
    const data = JSON.parse(raw), results = [];
    function walk(node) {
      if (!node || results.length >= limit) return;
      if (Array.isArray(node)) { for (const x of node) walk(x); return; }
      if (typeof node !== 'object') return;
      const r = node.videoRenderer;
      if (r?.videoId && r?.title?.runs?.length) {
        const title = r.title.runs.map(x => x.text || '').join('').trim();
        if (title) results.push({ title, link: `https://www.youtube.com/watch?v=${r.videoId}`, channel: r.ownerText?.runs?.map(x => x.text || '').join('').trim() || '', published: r.publishedTimeText?.simpleText || '', views: r.viewCountText?.simpleText || '', query, source: 'YouTube', signalType: 'content/search signal' });
      }
      for (const v of Object.values(node)) walk(v);
    }
    walk(data); return results;
  });
}
async function youtubeDiscovery(queries) {
  const selected = queries.filter(x => x.query.length > 8).slice(0, 10);
  return (await Promise.all(selected.map(x => youtubeSearch(x.query)))).flat();
}
function toArray(v) { return Array.isArray(v) ? v : (v == null || v === '' ? [] : [v]); }
function text(v, fallback = '') {
  if (typeof v === 'string') return v.trim() || fallback;
  if (typeof v === 'number') return String(v);
  if (v && typeof v === 'object') return v.detail || v.text || JSON.stringify(v);
  return fallback;
}
function normalizeEvidence(v, source = 'AI analysis') { return toArray(v).map(x => typeof x === 'string' ? { source, detail: x, url: '' } : { source: text(x?.source, source), detail: text(x?.detail || x?.text, text(x)), url: text(x?.url, '') }).filter(x => x.detail); }
function normalizeSources(v) { return toArray(v).map(x => typeof x === 'string' ? x : x?.url || x?.link || '').filter(x => /^https?:\/\//i.test(x)).slice(0, 10); }
function normalizeOpportunity(x, i) {
  const evidence = normalizeEvidence(x?.evidence), complaints = normalizeEvidence(x?.complaintsEvidence);
  const allowed = new Set(['High potential','Medium-high','Medium','Needs evidence']);
  return { category:text(x?.category,'Emerging problem'), title:text(x?.title,`Potential opportunity ${i+1}`), problem:text(x?.problem,'Specific problem needs further definition.'), trend:text(x?.trend,'Search-intent theme identified from live signals.'), score:allowed.has(x?.score) ? x.score : 'Needs evidence', confidence:Math.max(1,Math.min(10,Number.parseInt(x?.confidence,10)||1)), evidence:evidence.slice(0,7), products:text(x?.products,'No sufficiently specific existing solutions identified.'), complaintsEvidence:complaints.slice(0,6), gap:text(x?.gap,'No verified product gap yet.'), unproven:text(x?.unproven,'Search growth, willingness to pay and the product gap still need validation.'), audience:text(x?.audience,'Audience needs further investigation.'), ads:text(x?.ads,'Channel hypothesis only; validate.'), sell:text(x?.sell,'Sales-channel hypothesis only; validate.'), next:text(x?.next,'Validate the specific problem and gap before sourcing.'), sources:normalizeSources(x?.sources) };
}
function coverage(searchIntent, youtube, trends, reddit, news, model) { return { searchIntent, youtube, youtubeEnabled:true, googleTrends:trends, googleNews:news, reddit, model }; }

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ message:'GET only' });
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  if (!process.env.OPENAI_API_KEY) return res.status(200).json({ opportunities:[], sources:[], message:'OPENAI_API_KEY is not available to this deployment. Add it to Production and redeploy.' });
  try {
    const [searchQueries, trends] = await Promise.all([searchIntentDiscovery(), googleTrends()]);
    if (searchQueries.length < 10) return res.status(200).json({ opportunities:[], scannedAt:new Date().toISOString(), sourceCoverage:coverage(searchQueries.length,0,trends.length,0,0,model), message:'Search autocomplete returned too little discovery data for a reliable scan.' });
    const youtube = await youtubeDiscovery(searchQueries);
    if (youtube.length < 6) return res.status(200).json({ opportunities:[], scannedAt:new Date().toISOString(), sourceCoverage:coverage(searchQueries.length,youtube.length,trends.length,0,0,model), message:'Search intent was found, but YouTube returned too little corroborating content.' });

    // Research a small number of discovered queries in parallel. No categories or product ideas are supplied here.
    const leads = searchQueries.filter(x => x.query.length > 10).slice(0, 8);
    const researched = await Promise.all(leads.map(async lead => {
      const q = lead.query;
      const [reddit, news] = await Promise.all([redditSearch(`"${q}" problem OR issue OR frustrating OR difficult OR broken OR "doesn't work"`), googleNews(`"${q}" review OR complaint OR frustrating OR difficult OR "doesn't work"`)]);
      return { lead, reddit, news };
    }));
    const reddit = researched.flatMap(x => x.reddit), news = researched.flatMap(x => x.news);

    const client = new OpenAI({ apiKey:process.env.OPENAI_API_KEY });
    const prompt = `You are a strict commercial product-discovery auditor. Discover potential product opportunities from live search behaviour, not from predefined categories.

The engine has supplied: Google autocomplete completions for broad intent phrases; sampled YouTube results for those discovered queries; current UK Google Trends; Reddit customer discussions; and Google News review/complaint context.

Rules:
1. Autocomplete proves search behaviour only. It does NOT prove search volume, growth, demand or willingness to pay.
2. Never invent metrics, brands, products, prices, complaints, review counts, sentiment or URLs.
3. A YouTube title proves content/search interest, not a customer complaint.
4. Only return a potential opportunity when a SPECIFIC human problem is supported by multiple search/content signals AND at least one direct Reddit discussion OR genuinely problem-focused review/complaint result, with at least two independent evidence types overall.
5. Prefer concrete problems a physical or digital product could plausibly solve. Reject recipes, gaming walkthroughs, generic learning, celebrity/news and generic app-building.
6. If evidence is weak, return fewer opportunities or none. Do not force results.
7. The score is an evidence-strength label, not a recommendation or ranking.

Return ONLY JSON: {"opportunities":[{"category":"...","title":"...","problem":"...","trend":"...","score":"High potential|Medium-high|Medium|Needs evidence","confidence":1,"evidence":[{"source":"...","detail":"exact evidence-supported statement","url":"..."}],"products":"Existing solutions only if supported by supplied evidence.","complaintsEvidence":[{"source":"Reddit|Google News","detail":"exact evidence-supported customer/problem signal","url":"..."}],"gap":"Only state a recurring product gap if evidence supports it.","unproven":"What remains unknown.","audience":"Evidence-based audience description.","ads":"Hypothesis, clearly labelled as such.","sell":"Hypothesis, clearly labelled as such.","next":"Next validation step.","sources":["actual supplied URLs"]}]}. Use only supplied evidence.`;
    const data = JSON.stringify({ searchQueries, youtube, trends, reddit, news }).slice(0, 80000);
    const response = await client.chat.completions.create({ model, temperature:0, response_format:{type:'json_object'}, messages:[{role:'system',content:'Strict evidence-led market research. Never invent evidence.'},{role:'user',content:`${prompt}\n\nDATA:\n${data}`}] });
    const parsed = JSON.parse(response.choices?.[0]?.message?.content || '{}');
    const opportunities = toArray(parsed?.opportunities).map(normalizeOpportunity).filter(x => x.evidence.length >= 3 && x.complaintsEvidence.length >= 1 && x.sources.length >= 2 && x.score !== 'Needs evidence').slice(0,8);
    return res.status(200).json({ opportunities, scannedAt:new Date().toISOString(), sourceCoverage:coverage(searchQueries.length,youtube.length,trends.length,reddit.length,news.length,model), message:opportunities.length ? undefined : 'No sufficiently evidenced product opportunities found in this scan.' });
  } catch (e) {
    console.error('Scan failed:',e);
    return res.status(200).json({ opportunities:[], scannedAt:new Date().toISOString(), sourceCoverage:{model}, message:`Scan failed safely: ${e?.name === 'AbortError' ? 'a live source timed out' : (e?.message || 'unexpected server error')}. Try the scan again.` });
  }
};
