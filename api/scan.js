const OpenAI = require('openai');

function clean(value = '') {
  return String(value).replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
}

function rssItems(xml, limit = 25) {
  const items = [];
  const matches = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
  for (const block of matches.slice(0, limit)) {
    const title = clean((block.match(/<title>([\s\S]*?)<\/title>/i) || [,''])[1]);
    const link = clean((block.match(/<link>([\s\S]*?)<\/link>/i) || [,''])[1]);
    const pubDate = clean((block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i) || [,''])[1]);
    if (title) items.push({ title, link, pubDate });
  }
  return items;
}

async function fetchText(url, headers = {}) {
  const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TrendProductEngine/1.0)', ...headers } });
  if (!response.ok) throw new Error(`Source returned ${response.status}`);
  return response.text();
}

async function googleTrends() {
  try {
    return rssItems(await fetchText('https://trends.google.com/trending/rss?geo=GB'), 25)
      .map(x => ({ ...x, source: 'Google Trends', signalType: 'trending search' }));
  } catch (e) {
    console.error('Google Trends failed:', e.message);
    return [];
  }
}

async function googleNews(query, limit = 10, signalType = 'context') {
  try {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-GB&gl=GB&ceid=GB:en`;
    return rssItems(await fetchText(url), limit).map(x => ({ ...x, source: 'Google News', signalType }));
  } catch (e) {
    console.error('Google News failed:', e.message);
    return [];
  }
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
    } catch (e) {
      console.error('Reddit failed:', e.message);
    }
  }
  return [];
}

// Broad search-intent discovery. These are query shapes, not product categories.
// The engine asks public autocomplete services what people commonly complete them into.
async function autocompleteSuggestions(prefix) {
  const urls = [
    `https://suggestqueries.google.com/complete/search?client=firefox&hl=en-GB&q=${encodeURIComponent(prefix)}`,
    `https://www.google.com/complete/search?client=firefox&hl=en-GB&q=${encodeURIComponent(prefix)}`
  ];
  for (const url of urls) {
    try {
      const raw = await fetchText(url, { 'Accept': 'application/json,text/plain,*/*', 'Accept-Language': 'en-GB,en;q=0.9' });
      const data = JSON.parse(raw);
      const suggestions = Array.isArray(data?.[1]) ? data[1].map(x => typeof x === 'string' ? x : x?.[0]).filter(Boolean) : [];
      if (suggestions.length) return suggestions;
    } catch (e) {
      console.error('Autocomplete failed:', e.message);
    }
  }
  return [];
}

async function searchIntentDiscovery() {
  const prefixes = [
    'how to', 'how do I', 'how can I', 'how do you', 'help with',
    'alternative to', 'replacement for', 'best way to', 'problem with',
    'why does', 'is there a way to', 'what can I use instead of'
  ];
  const results = [];
  for (const prefix of prefixes) {
    const suggestions = await autocompleteSuggestions(prefix);
    suggestions.slice(0, 10).forEach(query => results.push({ query, prefix, source: 'Google Autocomplete', signalType: 'search-intent' }));
  }
  return Array.from(new Map(results.map(x => [x.query.toLowerCase(), x])).values()).slice(0, 100);
}

async function youtubeSearch(query, limit = 20) {
  try {
    const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
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
      if (!node || results.length >= limit) return;
      if (Array.isArray(node)) { for (const item of node) walk(item); return; }
      if (typeof node !== 'object') return;
      const renderer = node.videoRenderer;
      if (renderer?.videoId && renderer?.title?.runs?.length) {
        const title = renderer.title.runs.map(r => r.text || '').join('').trim();
        if (title) results.push({ title, link: `https://www.youtube.com/watch?v=${renderer.videoId}`, channel: renderer.ownerText?.runs?.map(r => r.text || '').join('').trim() || '', published: renderer.publishedTimeText?.simpleText || '', views: renderer.viewCountText?.simpleText || '', query, source: 'YouTube', signalType: 'content/search signal' });
      }
      for (const value of Object.values(node)) walk(value);
    }
    walk(data);
    return results;
  } catch (e) {
    console.error(`YouTube search failed for ${query}:`, e.message);
    return [];
  }
}

async function youtubeDiscovery(queries) {
  const selected = queries.slice(0, 24);
  const all = [];
  for (const item of selected) {
    const rows = await youtubeSearch(item.query, 8);
    all.push(...rows);
  }
  return all;
}

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null || value === '') return [];
  return [value];
}
function text(value, fallback = '') {
  if (typeof value === 'string') return value.trim() || fallback;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (value && typeof value === 'object') {
    if (typeof value.detail === 'string') return value.detail;
    if (typeof value.text === 'string') return value.text;
    return JSON.stringify(value);
  }
  return fallback;
}
function normalizeEvidence(value, defaultSource = 'AI analysis') {
  return toArray(value).map(item => typeof item === 'string' ? { source: defaultSource, detail: item } : { source: text(item?.source, defaultSource), detail: text(item?.detail || item?.text, text(item)), url: text(item?.url, '') }).filter(x => x.detail);
}
function normalizeSources(value) {
  return toArray(value).map(item => typeof item === 'string' ? item : item?.url || item?.link || '').filter(url => /^https?:\/\//i.test(url)).slice(0, 12);
}
function normalizeOpportunity(item, index) {
  const allowedScores = new Set(['High potential', 'Medium-high', 'Medium', 'Needs evidence']);
  const evidence = normalizeEvidence(item?.evidence), complaints = normalizeEvidence(item?.complaintsEvidence);
  return {
    category: text(item?.category, 'Emerging problem'), title: text(item?.title, `Potential opportunity ${index + 1}`), problem: text(item?.problem, 'A specific human problem needs further definition.'), trend: text(item?.trend, 'Search-intent theme identified from current source signals.'), score: allowedScores.has(item?.score) ? item.score : 'Needs evidence', confidence: Math.max(1, Math.min(10, Number.parseInt(item?.confidence, 10) || 1)), evidence: evidence.slice(0, 7), products: text(item?.products, 'No sufficiently specific existing solutions identified.'), complaintsEvidence: complaints.slice(0, 6), gap: text(item?.gap, 'No verified product gap yet; collect more customer evidence.'), unproven: text(item?.unproven, 'Search growth, willingness to pay and the product gap still need validation.'), audience: text(item?.audience, 'Audience needs further investigation.'), ads: text(item?.ads, 'Advertising channels need further investigation.'), sell: text(item?.sell, 'Sales channels need further investigation.'), next: text(item?.next, 'Validate the specific problem and product gap before sourcing.'), sources: normalizeSources(item?.sources)
  };
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ message: 'GET only' });
  if (!process.env.OPENAI_API_KEY) return res.status(200).json({ message: 'OPENAI_API_KEY is not available to this deployment. Add it to the Production environment and redeploy.', opportunities: [], sources: [] });

  let stage = 'starting';
  try {
    stage = 'discovering broad search intent';
    const [searchQueries, trendItems] = await Promise.all([searchIntentDiscovery(), googleTrends()]);
    if (searchQueries.length < 10) return res.status(200).json({ opportunities: [], scannedAt: new Date().toISOString(), sourceCoverage: { searchIntent: searchQueries.length, youtube: 0, youtubeEnabled: true, googleTrends: trendItems.length, googleNews: 0, reddit: 0, model: process.env.OPENAI_MODEL || 'gpt-4o-mini' }, message: 'Search autocomplete returned too little discovery data for a reliable scan.' });

    stage = 'sampling discovered search themes on YouTube';
    const youtube = await youtubeDiscovery(searchQueries);
    if (youtube.length < 10) return res.status(200).json({ opportunities: [], scannedAt: new Date().toISOString(), sourceCoverage: { searchIntent: searchQueries.length, youtube: youtube.length, youtubeEnabled: true, googleTrends: trendItems.length, googleNews: 0, reddit: 0, model: process.env.OPENAI_MODEL || 'gpt-4o-mini' }, message: 'The search-intent layer worked, but YouTube returned too little corroborating content.' });

    stage = 'clustering search intent and recurring problems';
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
    const discoveryPrompt = `You are the discovery layer of a commercial product research engine. The supplied data comes from broad search-intent autocomplete and YouTube sampling.

Do NOT use predefined product categories. Discover recurring HUMAN INTENTS from the data itself.

Look across these query styles: how to, how do I, how can I, how do you, help with, alternative to, replacement for, best way to, problem with, why does, is there a way to, what can I use instead of.

Identify up to 10 recurring themes where multiple distinct queries/content results point toward the same task, frustration, desired outcome, replacement need or unresolved problem. Prefer concrete physical-world problems that a product could plausibly solve. Reject recipes, game walkthroughs, celebrity/news topics, generic learning, generic app-building and entertainment unless the evidence reveals a separate concrete product problem.

Important: autocomplete presence is evidence of search behaviour, NOT proof of search volume or growth. You must not invent search volume. A theme can only be described as growing later if other supplied evidence supports that.

Return ONLY JSON: {"themes":[{"theme":"...","specificProblem":"...","searchEvidence":[{"query":"...","prefix":"..."}],"youtubeEvidence":[{"title":"...","url":"...","views":"...","published":"..."}]}]}. A theme needs at least 3 related evidence items across the supplied data. Use exact supplied queries and URLs. Never invent metrics.`;
    const discoveryResponse = await client.chat.completions.create({ model, temperature: 0, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: 'You are a strict search-intent clustering engine. Never invent evidence or metrics.' }, { role: 'user', content: `${discoveryPrompt}\n\nSEARCH INTENT DATA:\n${JSON.stringify(searchQueries).slice(0, 35000)}\n\nYOUTUBE DATA:\n${JSON.stringify(youtube).slice(0, 50000)}\n\nGOOGLE TRENDS DATA:\n${JSON.stringify(trendItems).slice(0, 15000)}` }] });
    const themes = toArray(JSON.parse(discoveryResponse.choices?.[0]?.message?.content || '{}')?.themes).filter(t => Array.isArray(t?.searchEvidence) && Array.isArray(t?.youtubeEvidence) && (t.searchEvidence.length + t.youtubeEvidence.length) >= 3).slice(0, 10);
    if (!themes.length) return res.status(200).json({ opportunities: [], scannedAt: new Date().toISOString(), sourceCoverage: { searchIntent: searchQueries.length, youtube: youtube.length, youtubeEnabled: true, googleTrends: trendItems.length, googleNews: 0, reddit: 0, model }, message: 'Broad search behaviour was found, but no recurring problem theme met the minimum evidence threshold.' });

    stage = 'testing discovered problems with customer evidence';
    const themeResearch = [];
    for (const theme of themes) {
      const q = text(theme.theme);
      const [reddit, complaints, context] = await Promise.all([
        redditSearch(`"${q}" problem OR issue OR frustrating OR difficult OR recommend OR recommendation OR broken OR "doesn't work"`),
        googleNews(`"${q}" review OR complaint OR frustrating OR difficult OR "doesn't work" OR "wish it"`, 10, 'review/complaint search'),
        googleNews(`"${q}" trend OR trending OR demand OR growing OR popular`, 8, 'trend/context signal')
      ]);
      themeResearch.push({ theme, reddit, complaints, context });
    }

    stage = 'auditing product opportunities';
    const rawSignals = { searchQueries, themes, themeResearch, googleTrends: trendItems };
    const compact = JSON.stringify(rawSignals).slice(0, 90000);
    const prompt = `You are the final commercial product-discovery auditor.

Start with broad search behaviour and recurring themes. Only turn a theme into a potential product opportunity if the supplied evidence demonstrates a SPECIFIC HUMAN PROBLEM that a product could plausibly solve.

MANDATORY EVIDENCE GATE:
1. The problem must be supported by multiple search-intent/content signals.
2. There must be at least 1 direct customer discussion from Reddit OR a genuine review/complaint result specifically about the discovered problem. Generic articles do not count as customer evidence.
3. There must be at least 2 independent evidence types overall.
4. Never convert a query such as "how to X" into a fabricated complaint about X.
5. Never invent search volume, growth, prices, brands, review counts, sentiment or demand.
6. Only call something "growing" or "trending" if the supplied evidence supports that description. Otherwise say "recurring search-intent theme".
7. Reject recipes, game walkthroughs, generic education, generic app tutorials and broad hobbies unless a separate concrete product problem is evidenced.
8. Do not force a result. Returning zero opportunities is correct.

The commercial chain must be: SEARCH INTENT -> RECURRING/GROWING THEME -> SPECIFIC HUMAN PROBLEM -> CUSTOMER EVIDENCE -> EXISTING SOLUTIONS -> UNRESOLVED GAP -> POTENTIAL PRODUCT CONCEPT -> VALIDATION TEST.

Existing solutions must be grounded in supplied evidence. If the sources do not identify products, say so rather than inventing brands.

For every returned opportunity provide exactly: category,title,problem,trend,score,confidence,evidence,products,complaintsEvidence,gap,unproven,audience,ads,sell,next,sources.

Evidence must contain factual observations and exact URLs/queries from supplied data. complaintsEvidence may ONLY use Reddit or genuine review/complaint-search evidence. Do not imply demand is proven. The score is an evidence status, not a prediction of sales.

Return ONLY JSON: {"opportunities":[...]}.`;
    const response = await client.chat.completions.create({ model, temperature: 0, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: 'You are a strict commercial evidence auditor. Reject generic or unsupported ideas. Never fabricate customer voice, products or market metrics.' }, { role: 'user', content: `${prompt}\n\nLIVE RESEARCH DATA:\n${compact}` }] });
    stage = 'processing opportunity evidence';
    const content = response.choices?.[0]?.message?.content;
    if (!content) throw new Error('OpenAI returned an empty response');
    const parsed = JSON.parse(content);
    const opportunities = toArray(parsed?.opportunities).map(normalizeOpportunity).filter(x => x.title && x.evidence.length >= 3 && x.complaintsEvidence.length >= 1 && x.sources.length >= 3 && x.score !== 'Needs evidence');

    return res.status(200).json({
      opportunities,
      scannedAt: new Date().toISOString(),
      sourceCoverage: {
        searchIntent: searchQueries.length,
        youtube: youtube.length,
        youtubeEnabled: true,
        googleTrends: trendItems.length,
        googleNews: themeResearch.reduce((n, x) => n + x.complaints.length + x.context.length, 0),
        reddit: themeResearch.reduce((n, x) => n + x.reddit.length, 0),
        model
      },
      message: opportunities.length ? undefined : 'Search themes were discovered, but none passed the customer-evidence and product-problem tests.'
    });
  } catch (error) {
    console.error(`Live scan failed at ${stage}:`, error);
    const detail = error?.status === 401 ? 'OpenAI rejected the API key.' : error?.status === 429 ? 'OpenAI rate limit or billing limit reached.' : error?.message || 'Unknown error';
    return res.status(500).json({ message: `Live scan failed while ${stage}: ${detail}`, stage });
  }
};
