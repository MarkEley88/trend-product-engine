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
    `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=new&limit=10`,
    `https://old.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=new&limit=10`
  ];
  for (const url of urls) {
    try {
      const response = await fetch(url, { headers: { 'User-Agent': 'TrendProductEngine/1.0 research bot' } });
      if (!response.ok) continue;
      const data = await response.json();
      return (data?.data?.children || []).map(x => ({ title: x?.data?.title || '', link: x?.data?.permalink ? `https://www.reddit.com${x.data.permalink}` : '', pubDate: x?.data?.created_utc ? new Date(x.data.created_utc * 1000).toISOString() : '', source: 'Reddit', signalType: 'customer discussion' })).filter(x => x.title);
    } catch (e) { console.error('Reddit failed:', e.message); }
  }
  return [];
}

// YouTube's public search page is used for discovery so the prototype does not require a paid data provider.
// OpenAI then interprets the actual returned video titles/metadata; the app does not invent search themes.
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
      if (!node || results.length >= 50) return;
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
function normalizeSources(value) { return toArray(value).map(item => typeof item === 'string' ? item : item?.url || item?.link || '').filter(url => /^https?:\/\//i.test(url)).slice(0, 8); }
function normalizeOpportunity(item, index) {
  const allowedScores = new Set(['High potential', 'Medium-high', 'Medium', 'Needs evidence']);
  const evidence = normalizeEvidence(item?.evidence), complaints = normalizeEvidence(item?.complaintsEvidence);
  return { category: text(item?.category, 'Emerging theme'), title: text(item?.title, `Potential opportunity ${index + 1}`), problem: text(item?.problem, 'A specific human problem needs further definition.'), trend: text(item?.trend, 'Theme identified from current source signals.'), score: allowedScores.has(item?.score) ? item.score : 'Needs evidence', confidence: Math.max(1, Math.min(10, Number.parseInt(item?.confidence, 10) || 1)), evidence: evidence.slice(0, 6), products: text(item?.products, 'No sufficiently specific existing solutions identified.'), complaintsEvidence: complaints.slice(0, 5), gap: text(item?.gap, 'No verified product gap yet; collect more customer evidence.'), unproven: text(item?.unproven, 'The strongest unresolved complaint, willingness to pay and product gap still need validation.'), audience: text(item?.audience, 'Audience needs further investigation.'), ads: text(item?.ads, 'Advertising channels need further investigation.'), sell: text(item?.sell, 'Sales channels need further investigation.'), next: text(item?.next, 'Collect more product-review and customer-discussion evidence before making a product decision.'), sources: normalizeSources(item?.sources) };
}
module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ message: 'GET only' });
  if (!process.env.OPENAI_API_KEY) return res.status(200).json({ message: 'OPENAI_API_KEY is not available to this deployment. Add it to the Production environment and redeploy.', opportunities: [], sources: [] });
  let stage = 'starting';
  try {
    stage = 'discovering YouTube how-to themes';
    const [youtube, trendItems] = await Promise.all([youtubeWebSearch(), googleTrends()]);
    stage = 'collecting supporting discussion and review signals';
    const reddit = await redditSearch('"how to" problem OR issue OR recommendation OR review');
    const contextNews = await googleNews('"how to" problem OR fix OR difficult OR review', 20, 'supporting context');
    const rawSignals = { youtube, googleTrends: trendItems, reddit, contextNews };
    const compact = JSON.stringify(rawSignals).slice(0, 70000);
    stage = 'calling OpenAI';
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
    const prompt = `You are the discovery and commercial research engine for a product opportunity platform.

The user does NOT want predefined categories or searches. The engine has gone directly to YouTube and asked the market through a broad "how to" search. Your job is to analyse the ACTUAL returned YouTube results and discover the themes that are emerging from them.

Do not start from Automotive, Home, Pets or Travel. Those old categories are gone from discovery. A theme may come from any subject.

FIRST: cluster the supplied YouTube results into specific recurring themes. Prefer themes where multiple videos independently point to the same task, problem, frustration or desired outcome. Do not simply repeat one video title.

SECOND: turn the strongest themes into specific human problems. A useful result looks like: clearly defined person + situation + recurring pain + evidence + existing solution/product context + unresolved need that a product could plausibly improve.

THIRD: use Reddit, Google Trends and Google News only as supporting evidence. Reddit is customer discussion. Google Trends is a search-demand signal. Google News is context/discovery evidence, NOT customer voice.

FOURTH: only return a potential product opportunity where the evidence is sufficiently specific. If a theme is interesting but there is not enough evidence of a concrete problem or customer gap, reject it rather than filling the list.

Required chain: YOUTUBE TREND/THEME -> SPECIFIC HUMAN PROBLEM -> EXISTING SOLUTIONS -> CUSTOMER VOICE / COMPLAINT -> UNRESOLVED NEED -> POTENTIAL PRODUCT CONCEPT -> TEST.

CRITICAL RULES:
- Do not invent search volume, growth rates, prices, brands, review counts, market sizes, sentiment or demand.
- Do not call something "trending" merely because one video exists. Explain the evidence actually supplied.
- YouTube search results are signals of content/search interest, not proof of sales demand.
- Every opportunity needs at least 2 independent evidence observations.
- At least one must be a customer discussion or review/complaint signal from Reddit or the supplied review/context stream. If no credible customer voice exists, reject the opportunity.
- Do not manufacture a complaint from a video title.
- Existing products should only be named if supplied evidence names them.
- Do not force a result from every theme or category.
- Avoid generic ideas. The output should be specific enough that someone could investigate or source a product against the exact problem.
- A potential opportunity is not guaranteed demand.
- confidence measures evidence strength, not commercial success probability.

For every opportunity return exactly:
category,title,problem,trend,score,confidence,evidence,products,complaintsEvidence,gap,unproven,audience,ads,sell,next,sources.

Evidence items must contain source, detail and URL when available. complaintsEvidence must contain only direct Reddit/customer discussion or review/complaint evidence. sources must contain exact URLs from supplied data only.

Return ONLY JSON: {"opportunities":[...]}

SUPPLIED LIVE DATA:\n${compact}`;
    const response = await client.chat.completions.create({ model, temperature: 0.05, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: 'You are a strict evidence auditor and trend researcher. Discover themes from supplied source data. Never fabricate evidence.' }, { role: 'user', content: prompt }] });
    stage = 'processing OpenAI response';
    const content = response.choices?.[0]?.message?.content; if (!content) throw new Error('OpenAI returned an empty response');
    const parsed = JSON.parse(content);
    const opportunities = toArray(parsed?.opportunities).map(normalizeOpportunity).filter(x => x.title && x.evidence.length >= 2 && x.complaintsEvidence.length >= 1 && x.sources.length >= 2);
    return res.status(200).json({ opportunities, scannedAt: new Date().toISOString(), sourceCoverage: { youtube: youtube.length, youtubeEnabled: true, googleTrends: trendItems.length, googleNews: contextNews.length, reddit: reddit.length, model }, message: opportunities.length ? undefined : 'YouTube themes were found, but the evidence did not meet the specificity threshold for a product opportunity.' });
  } catch (error) {
    console.error(`Live scan failed at ${stage}:`, error); const detail = error?.status === 401 ? 'OpenAI rejected the API key.' : error?.status === 429 ? 'OpenAI rate limit or billing limit reached.' : error?.message || 'Unknown error'; return res.status(500).json({ message: `Live scan failed while ${stage}: ${detail}`, stage });
  }
};
