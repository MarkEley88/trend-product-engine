const OpenAI = require('openai');

function clean(value = '') { return String(value).replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim(); }
function rssItems(xml, limit = 25) {
  const items = []; const matches = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
  for (const block of matches.slice(0, limit)) {
    const title = clean((block.match(/<title>([\s\S]*?)<\/title>/i) || [,''])[1]);
    const link = clean((block.match(/<link>([\s\S]*?)<\/link>/i) || [,''])[1]);
    const pubDate = clean((block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i) || [,''])[1]);
    if (title) items.push({ title, link, pubDate });
  }
  return items;
}
async function fetchText(url, headers = {}) { const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TrendProductEngine/1.0)', ...headers } }); if (!response.ok) throw new Error(`Source returned ${response.status}`); return response.text(); }
async function googleTrends() {
  try { return rssItems(await fetchText('https://trends.google.com/trending/rss?geo=GB'), 25).map(x => ({ ...x, source: 'Google Trends', signalType: 'trending search' })); }
  catch (e) { console.error('Google Trends failed:', e.message); return []; }
}
async function googleNews(query, limit = 10, signalType = 'context') {
  try { const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-GB&gl=GB&ceid=GB:en`; return rssItems(await fetchText(url), limit).map(x => ({ ...x, source: 'Google News', signalType })); }
  catch (e) { console.error('Google News failed:', e.message); return []; }
}
async function redditSearch(query) {
  const urls = [
    `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=relevance&limit=15`,
    `https://old.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=relevance&limit=15`,
    `https://www.reddit.com/search.rss?q=${encodeURIComponent(query)}&sort=relevance&limit=15`
  ];
  for (const url of urls) {
    try {
      const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TrendProductEngine/1.0 research bot)', 'Accept': 'application/json, application/rss+xml, application/xml, text/xml' } });
      if (!response.ok) continue;
      const type = response.headers.get('content-type') || '';
      if (type.includes('json') || url.includes('search.json')) {
        const data = await response.json();
        const rows = (data?.data?.children || []).map(x => ({ title: x?.data?.title || '', link: x?.data?.permalink ? `https://www.reddit.com${x.data.permalink}` : '', pubDate: x?.data?.created_utc ? new Date(x.data.created_utc * 1000).toISOString() : '', source: 'Reddit', signalType: 'customer discussion' })).filter(x => x.title);
        if (rows.length) return rows;
      } else {
        const rows = rssItems(await response.text(), 15).map(x => ({ ...x, source: 'Reddit', signalType: 'customer discussion' }));
        if (rows.length) return rows;
      }
    } catch (e) { console.error('Reddit failed:', e.message); }
  }
  return [];
}

// Public YouTube search is used only to discover the actual content themes.
// No predefined product categories or problem queries are supplied.
async function youtubeWebSearch() {
  try {
    const url = 'https://www.youtube.com/results?search_query=how%20to';
    const html = await fetchText(url, { 'Accept-Language': 'en-GB,en;q=0.9' });
    const marker = 'var ytInitialData = ';
    const start = html.indexOf(marker);
    if (start < 0) throw new Error('YouTube search data was not found');
    const jsonStart = start + marker.length;
    const end = html.indexOf(';var ytInitialPlayerResponse', jsonStart);
    const raw = end > jsonStart ? html.slice(jsonStart, end) : html.slice(jsonStart, html.indexOf('</script>', jsonStart));
    const data = JSON.parse(raw.trim().replace(/;$/, ''));
    const results = [];
    function walk(node) {
      if (!node || results.length >= 60) return;
      if (Array.isArray(node)) { for (const item of node) walk(item); return; }
      if (typeof node !== 'object') return;
      const renderer = node.videoRenderer;
      if (renderer?.videoId && renderer?.title?.runs?.length) {
        const title = renderer.title.runs.map(r => r.text || '').join('').trim();
        const channel = renderer.ownerText?.runs?.map(r => r.text || '').join('').trim() || '';
        const published = renderer.publishedTimeText?.simpleText || '';
        const views = renderer.viewCountText?.simpleText || '';
        if (title) results.push({ title, link: `https://www.youtube.com/watch?v=${renderer.videoId}`, channel, published, views, source: 'YouTube', signalType: 'YouTube search result' });
      }
      for (const value of Object.values(node)) walk(value);
    }
    walk(data);
    return results;
  } catch (e) { console.error('YouTube web search failed:', e.message); return []; }
}
function toArray(value) { if (Array.isArray(value)) return value; if (value == null || value === '') return []; return [value]; }
function text(value, fallback = '') { if (typeof value === 'string') return value.trim() || fallback; if (typeof value === 'number') return String(value); if (typeof value === 'boolean') return value ? 'Yes' : 'No'; if (value && typeof value === 'object') { if (typeof value.detail === 'string') return value.detail; if (typeof value.text === 'string') return value.text; return JSON.stringify(value); } return fallback; }
function normalizeEvidence(value, defaultSource = 'AI analysis') { return toArray(value).map(item => typeof item === 'string' ? { source: defaultSource, detail: item } : { source: text(item?.source, defaultSource), detail: text(item?.detail || item?.text, text(item)), url: text(item?.url, '') }).filter(x => x.detail); }
function normalizeSources(value) { return toArray(value).map(item => typeof item === 'string' ? item : item?.url || item?.link || '').filter(url => /^https?:\/\//i.test(url)).slice(0, 10); }
function normalizeOpportunity(item, index) {
  const allowedScores = new Set(['High potential', 'Medium-high', 'Medium', 'Needs evidence']);
  const evidence = normalizeEvidence(item?.evidence), complaints = normalizeEvidence(item?.complaintsEvidence);
  return { category: text(item?.category, 'Emerging theme'), title: text(item?.title, `Potential opportunity ${index + 1}`), problem: text(item?.problem, 'A specific human problem needs further definition.'), trend: text(item?.trend, 'Theme identified from current source signals.'), score: allowedScores.has(item?.score) ? item.score : 'Needs evidence', confidence: Math.max(1, Math.min(10, Number.parseInt(item?.confidence, 10) || 1)), evidence: evidence.slice(0, 6), products: text(item?.products, 'No sufficiently specific existing solutions identified.'), complaintsEvidence: complaints.slice(0, 5), gap: text(item?.gap, 'No verified product gap yet; collect more customer evidence.'), unproven: text(item?.unproven, 'The strongest unresolved complaint, willingness to pay and product gap still need validation.'), audience: text(item?.audience, 'Audience needs further investigation.'), ads: text(item?.ads, 'Advertising channels need further investigation.'), sell: text(item?.sell, 'Sales channels need further investigation.'), next: text(item?.next, 'Collect more evidence before making a product decision.'), sources: normalizeSources(item?.sources) };
}
module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ message: 'GET only' });
  if (!process.env.OPENAI_API_KEY) return res.status(200).json({ message: 'OPENAI_API_KEY is not available to this deployment. Add it to the Production environment and redeploy.', opportunities: [], sources: [] });
  let stage = 'starting';
  try {
    stage = 'discovering YouTube how-to themes';
    const [youtube, trendItems] = await Promise.all([youtubeWebSearch(), googleTrends()]);
    if (youtube.length < 3) return res.status(200).json({ opportunities: [], scannedAt: new Date().toISOString(), sourceCoverage: { youtube: youtube.length, youtubeEnabled: true, googleTrends: trendItems.length, googleNews: 0, reddit: 0, model: process.env.OPENAI_MODEL || 'gpt-4o-mini' }, message: 'YouTube returned too little discovery data for a reliable theme scan.' });

    stage = 'clustering YouTube themes';
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
    const discoveryPrompt = `Analyse ONLY the supplied YouTube search results for the broad query "how to". Do not use predefined categories. Cluster the videos into recurring themes.

A theme must be supported by at least 3 genuinely related videos. Do not treat one viral-looking title as a trend. Prefer repeated tasks, problems or desired outcomes. Ignore entertainment/game walkthroughs, celebrity/news stories, recipes and other subjects where the likely commercial product connection is weak unless multiple videos reveal a concrete physical problem that a product could solve.

Return only JSON: {"themes":[{"theme":"...","problem":"...","videoEvidence":[{"title":"...","url":"...","views":"...","published":"..."}]}]}. Return at most 8 themes. Use exact URLs from the data. Do not invent metrics.`;
    const discoveryResponse = await client.chat.completions.create({ model, temperature: 0, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: 'You are a strict trend clustering engine. Never invent evidence.' }, { role: 'user', content: `${discoveryPrompt}\n\nYOUTUBE DATA:\n${JSON.stringify(youtube).slice(0, 65000)}` }] });
    const themes = toArray(JSON.parse(discoveryResponse.choices?.[0]?.message?.content || '{}')?.themes).filter(t => Array.isArray(t?.videoEvidence) && t.videoEvidence.length >= 3).slice(0, 8);
    if (!themes.length) return res.status(200).json({ opportunities: [], scannedAt: new Date().toISOString(), sourceCoverage: { youtube: youtube.length, youtubeEnabled: true, googleTrends: trendItems.length, googleNews: 0, reddit: 0, model }, message: 'YouTube content was found, but no recurring how-to theme met the minimum evidence threshold.' });

    stage = 'testing discovered themes for customer problems';
    const themeResearch = [];
    for (const theme of themes) {
      const q = text(theme.theme);
      const [reddit, complaints, trends] = await Promise.all([
        redditSearch(`"${q}" problem OR issue OR frustrating OR difficult OR recommend OR recommendation OR broken OR "doesn't work"`),
        googleNews(`"${q}" review OR complaint OR frustrating OR difficult OR "doesn't work" OR "wish it"`, 10, 'review/complaint search'),
        googleNews(`"${q}" trend OR trending OR demand OR popular`, 8, 'supporting trend signal')
      ]);
      themeResearch.push({ theme, reddit, complaints, trends });
    }

    stage = 'calling OpenAI for evidence-led opportunities';
    const rawSignals = { youtubeThemes: themes, themeResearch, googleTrends: trendItems };
    const compact = JSON.stringify(rawSignals).slice(0, 75000);
    const prompt = `You are the final commercial product-discovery auditor.

Start with the discovered YouTube themes. Only turn a theme into a potential product opportunity if the supplied evidence demonstrates a SPECIFIC HUMAN PROBLEM that a product could plausibly solve.

A useful result is NOT a recipe, game guide, app tutorial, generic hobby, generic service or broad content trend. It should be a concrete problem such as a person trying to do/fix/remove/protect/organise something where an existing product may be inadequate or an obvious product solution may be missing.

MANDATORY EVIDENCE GATE:
1. At least 3 related YouTube videos must support the same theme.
2. There must be at least 1 direct customer discussion from Reddit OR a genuine review/complaint result specifically about the discovered problem. If Reddit/review evidence is absent or only generic, REJECT the opportunity.
3. There must be at least 2 independent evidence types overall.
4. Never convert a YouTube title into a fabricated customer complaint.
5. Never invent search volume, growth, prices, brands, review counts, sentiment or demand.
6. Do not call something "trending" unless the supplied data supports that description; otherwise call it a recurring content/search theme.
7. Reject themes like individual recipes, game walkthroughs and "how to build an app with AI" unless the evidence reveals a separate physical/digital product problem with customer pain.
8. Do not force a result. Returning zero opportunities is correct.

Required chain: YOUTUBE THEME -> SPECIFIC HUMAN PROBLEM -> CUSTOMER EVIDENCE -> EXISTING SOLUTIONS -> UNRESOLVED GAP -> POTENTIAL PRODUCT CONCEPT -> TEST.

For every returned opportunity provide exactly: category,title,problem,trend,score,confidence,evidence,products,complaintsEvidence,gap,unproven,audience,ads,sell,next,sources.

Evidence must contain factual observations and exact URLs from supplied data. complaintsEvidence may ONLY use Reddit or review/complaint-search evidence. The product concept should be described in gap/next without pretending demand is proven.

Return ONLY JSON: {"opportunities":[...]}.`;
    const response = await client.chat.completions.create({ model, temperature: 0, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: 'You are a strict commercial evidence auditor. Reject generic or unsupported ideas. Never fabricate customer voice.' }, { role: 'user', content: `${prompt}\n\nLIVE RESEARCH DATA:\n${compact}` }] });
    stage = 'processing OpenAI response';
    const content = response.choices?.[0]?.message?.content; if (!content) throw new Error('OpenAI returned an empty response');
    const parsed = JSON.parse(content);
    const opportunities = toArray(parsed?.opportunities).map(normalizeOpportunity).filter(x => x.title && x.evidence.length >= 3 && x.complaintsEvidence.length >= 1 && x.sources.length >= 3 && x.score !== 'Needs evidence');
    return res.status(200).json({ opportunities, scannedAt: new Date().toISOString(), sourceCoverage: { youtube: youtube.length, youtubeEnabled: true, googleTrends: trendItems.length, googleNews: themeResearch.reduce((n, x) => n + x.complaints.length + x.trends.length, 0), reddit: themeResearch.reduce((n, x) => n + x.reddit.length, 0), model }, message: opportunities.length ? undefined : 'Themes were discovered from YouTube, but none passed the customer-evidence and product-problem tests.' });
  } catch (error) {
    console.error(`Live scan failed at ${stage}:`, error); const detail = error?.status === 401 ? 'OpenAI rejected the API key.' : error?.status === 429 ? 'OpenAI rate limit or billing limit reached.' : error?.message || 'Unknown error'; return res.status(500).json({ message: `Live scan failed while ${stage}: ${detail}`, stage });
  }
};
