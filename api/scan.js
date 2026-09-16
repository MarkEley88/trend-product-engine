const OpenAI = require('openai');

const UA = 'Mozilla/5.0 (compatible; TrendProductEngine/1.0)';
const TIMEOUT_MS = 3500;

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
    return Array.isArray(data?.[1]) ? data[1].map(x => typeof x === 'string' ? x : x?.[0]).filter(Boolean).slice(0, 10) : [];
  });
}

async function searchIntentDiscovery() {
  // Broad intent phrases + alphabetic variations make autocomplete discovery much less generic.
  // No product category is supplied to the engine.
  const bases = ['how to','how do I','how can I','help with','alternative to','replacement for','best way to','problem with','why does','is there a way to','what can I use instead of'];
  const variants = ['', ' a', ' c', ' m', ' s', ' t'];
  const jobs = bases.flatMap(base => variants.map(v => ({ prefix: base + v })));
  const batches = await Promise.all(jobs.map(async job => ({ ...job, suggestions: await autocomplete(job.prefix) })));
  const rows = [];
  for (const b of batches) for (const query of b.suggestions) rows.push({ query, prefix: b.prefix, source: 'Google Autocomplete', signalType: 'search-intent' });
  return Array.from(new Map(rows.map(x => [x.query.toLowerCase(), x])).values()).filter(x => x.query.length > 12).slice(0, 180);
}

async function googleTrends() {
  return safe(async () => rssItems(await fetchText('https://trends.google.com/trending/rss?geo=GB'), 30).map(x => ({ ...x, source: 'Google Trends', signalType: 'trending search' })));
}
async function googleNews(query, limit = 8, signalType = 'context') {
  return safe(async () => rssItems(await fetchText(`https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-GB&gl=GB&ceid=GB:en`, limit).then(x => x), limit).map(x => ({ ...x, source: 'Google News', signalType })));
}
async function redditSearch(query) {
  return safe(async () => {
    const r = await fetch(`https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=relevance&limit=12`, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'User-Agent': UA, Accept: 'application/json' } });
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
  const selected = queries.filter(x => x.query.length > 15).slice(0, 12);
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
function normalizeSources(v) { return toArray(v).map(x => typeof x === 'string' ? x : x?.url || x?.link || '').filter(x => /^https?:\/\//i.test(x)).slice(0, 12); }
function normalizeOpportunity(x, i) {
  const evidence = normalizeEvidence(x?.evidence), complaints = normalizeEvidence(x?.complaintsEvidence);
  const allowed = new Set(['High potential','Medium-high','Medium','Needs evidence']);
  return { category:text(x?.category,'Emerging problem'), title:text(x?.title,`Potential opportunity ${i+1}`), problem:text(x?.problem,'Specific problem needs further definition.'), trend:text(x?.trend,'Search-intent theme identified from live signals.'), score:allowed.has(x?.score) ? x.score : 'Needs evidence', confidence:Math.max(1,Math.min(10,Number.parseInt(x?.confidence,10)||1)), evidence:evidence.slice(0,8), products:text(x?.products,'No sufficiently specific existing solutions identified.'), complaintsEvidence:complaints.slice(0,7), gap:text(x?.gap,'No verified product gap yet.'), unproven:text(x?.unproven,'Search growth, willingness to pay and the product gap still need validation.'), audience:text(x?.audience,'Audience needs further investigation.'), ads:text(x?.ads,'Channel hypothesis only; validate.'), sell:text(x?.sell,'Sales-channel hypothesis only; validate.'), next:text(x?.next,'Validate the specific problem and gap before sourcing.'), sources:normalizeSources(x?.sources) };
}
function coverage(searchIntent, youtube, trends, reddit, news, model) { return { searchIntent, youtube, youtubeEnabled:true, googleTrends:trends, googleNews:news, reddit, model }; }

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ message:'GET only' });
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  if (!process.env.OPENAI_API_KEY) return res.status(200).json({ opportunities:[], sources:[], message:'OPENAI_API_KEY is not available to this deployment. Add it to Production and redeploy.' });
  try {
    const [searchQueries, trends] = await Promise.all([searchIntentDiscovery(), googleTrends()]);
    if (searchQueries.length < 30) return res.status(200).json({ opportunities:[], scannedAt:new Date().toISOString(), sourceCoverage:coverage(searchQueries.length,0,trends.length,0,0,model), message:'Search discovery returned too little data for a reliable scan.' });

    const youtube = await youtubeDiscovery(searchQueries);
    const client = new OpenAI({ apiKey:process.env.OPENAI_API_KEY });

    // Stage 1: cluster the internet/search behaviour into concrete problems.
    const discoveryPrompt = `You are the first stage of a commercial product research engine. Discover recurring HUMAN PROBLEMS from broad live search behaviour. Do not start from categories or product ideas.

Data sources: Google autocomplete completions for broad intent phrases, sampled YouTube results for discovered queries, and current UK Google Trends.

Find up to 12 concrete problem themes where multiple distinct queries/content signals point to the same task, frustration, replacement need, recurring difficulty or desired outcome. Prefer problems that could plausibly be solved by a physical or digital product. Reject recipes, game walkthroughs, generic learning, celebrity/news, generic AI/app tutorials and entertainment.

CRITICAL: autocomplete presence means people search for something; it does NOT prove volume, growth, demand or willingness to pay. Never invent metrics. Do not call anything trending unless supplied trend data actually supports it.

Return ONLY JSON: {"themes":[{"theme":"short name","problem":"specific human problem","searchEvidence":[{"query":"exact supplied query","prefix":"exact supplied prefix"}],"contentEvidence":[{"title":"exact supplied title","url":"exact supplied URL","views":"exact supplied value or blank"}]}]}. Each theme must have at least 3 evidence items, with at least 2 distinct search queries. Use only supplied evidence.`;
    const discoveryData = JSON.stringify({ searchQueries, youtube, trends }).slice(0, 70000);
    const r1 = await client.chat.completions.create({ model, temperature:0, response_format:{type:'json_object'}, messages:[{role:'system',content:'Strict evidence-led search-intent clustering. Never invent evidence or metrics.'},{role:'user',content:`${discoveryPrompt}\n\nDATA:\n${discoveryData}`}] });
    const themes = toArray(JSON.parse(r1.choices?.[0]?.message?.content || '{}')?.themes).filter(t => Array.isArray(t?.searchEvidence) && t.searchEvidence.length >= 2 && Array.isArray(t?.contentEvidence) && (t.searchEvidence.length + t.contentEvidence.length) >= 3).slice(0,10);
    if (!themes.length) return res.status(200).json({ opportunities:[], scannedAt:new Date().toISOString(), sourceCoverage:coverage(searchQueries.length,youtube.length,trends.length,0,0,model), message:'Broad search behaviour was found, but no concrete recurring problem theme was supported by enough independent signals.' });

    // Stage 2: independently test the discovered problems against customer/review discussion.
    const research = await Promise.all(themes.map(async theme => {
      const q = text(theme.problem || theme.theme);
      const queries = [q, `${q} problem`, `${q} review`, `${q} frustrating`, `${q} doesn't work`];
      const results = await Promise.all(queries.map(async term => {
        const [reddit, news] = await Promise.all([
          redditSearch(term),
          googleNews(`"${term}"`, 6, 'review/complaint context')
        ]);
        return { term, reddit, news };
      }));
      return { theme, reddit:results.flatMap(x=>x.reddit), news:results.flatMap(x=>x.news) };
    }));
    const reddit = research.flatMap(x=>x.reddit), news = research.flatMap(x=>x.news);

    const finalPrompt = `You are the final commercial product-discovery auditor. Start with the discovered search-intent themes and test whether they are real product problems.

MANDATORY RULES:
1. Search/autocomplete/content signals establish behaviour, not search volume, growth or willingness to pay.
2. A YouTube title is NOT a customer complaint.
3. A theme may become a potential opportunity only when the problem is specific, has multiple independent search/content signals, AND has at least one genuine customer/problem signal from Reddit OR a clearly problem-focused review/complaint result. Two independent evidence types are required overall.
4. Do NOT require Reddit specifically when a genuine review/complaint source is supplied; Reddit is only one possible customer-voice source.
5. Never invent products, brands, prices, complaints, review counts, market size, search volume, growth, sentiment or URLs.
6. Google News articles are context unless the supplied title itself clearly reports a customer review/complaint. Do not turn generic articles into customer evidence.
7. Prefer concrete physical-world or digital product problems. Reject recipes, games, celebrity/news, generic learning and generic app-building.
8. If evidence is insufficient, return no opportunity for that theme. Do not force results.
9. The score is an evidence-strength label, not a ranking or recommendation.

For each accepted opportunity, explain the problem, the evidence, existing solutions ONLY where supplied evidence supports them, recurring customer pain, and any product gap. Clearly separate what is evidenced from what remains unproven. Ads and sales channels are hypotheses, not facts.

Return ONLY JSON in this exact shape: {"opportunities":[{"category":"descriptive category derived from the problem","title":"specific potential product opportunity","problem":"specific human problem","trend":"what the supplied evidence actually shows; do not claim growth without evidence","score":"High potential|Medium-high|Medium|Needs evidence","confidence":1,"evidence":[{"source":"Google Autocomplete|YouTube|Google Trends|Reddit|Google News","detail":"fact supported by supplied data","url":"actual supplied URL or blank"}],"products":"Only evidenced existing solutions; otherwise say none identified from supplied data.","complaintsEvidence":[{"source":"Reddit|Google News","detail":"actual customer/review/problem evidence from supplied data","url":"actual supplied URL"}],"gap":"Evidence-supported recurring gap, or say not established.","unproven":"What is still unknown.","audience":"Audience supported by the evidence.","ads":"Hypothesis only.","sell":"Hypothesis only.","next":"Specific next validation step.","sources":["actual supplied URLs"]}]}.`;
    const finalData = JSON.stringify({ themes, research, trends }).slice(0,85000);
    const r2 = await client.chat.completions.create({ model, temperature:0, response_format:{type:'json_object'}, messages:[{role:'system',content:'Strict commercial research auditor. Never manufacture evidence.'},{role:'user',content:`${finalPrompt}\n\nRESEARCH DATA:\n${finalData}`}] });
    const parsed = JSON.parse(r2.choices?.[0]?.message?.content || '{}');
    const opportunities = toArray(parsed?.opportunities).map(normalizeOpportunity).filter(x => x.evidence.length >= 3 && x.complaintsEvidence.length >= 1 && x.sources.length >= 2 && x.score !== 'Needs evidence').slice(0,8);
    return res.status(200).json({ opportunities, scannedAt:new Date().toISOString(), sourceCoverage:coverage(searchQueries.length,youtube.length,trends.length,reddit.length,news.length,model), message:opportunities.length ? undefined : 'No sufficiently evidenced product opportunities found in this scan.' });
  } catch (e) {
    console.error('Scan failed:',e);
    return res.status(200).json({ opportunities:[], scannedAt:new Date().toISOString(), sourceCoverage:{model}, message:`Scan failed safely: ${e?.name === 'AbortError' ? 'a live source timed out' : (e?.message || 'unexpected server error')}. Try the scan again.` });
  }
};