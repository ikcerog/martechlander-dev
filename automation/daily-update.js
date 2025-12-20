// automation/daily-update.js
// Headless script for daily RSS feed aggregation and Claude AI summary generation

const fs = require('fs').promises;
const fetch = require('node-fetch').default || require('node-fetch');
require('dotenv').config();

// Configuration
const CACHE_FILE = 'summary_cache.txt';
const THROTTLE_MINUTES = 91;
const THROTTLE_MILLISECONDS = THROTTLE_MINUTES * 60 * 1000;
const apiKey = process.env.CLAUDE_API_KEY ? process.env.CLAUDE_API_KEY.trim() : null;
const CLAUDE_MODEL = "claude-sonnet-4-5";
const API_URL = "https://api.anthropic.com/v1/messages";
const RSS_TO_JSON_PROXY_BASE = 'https://api.rss2json.com/v1/api.json?rss_url=';

// RSS Feed Sources
const EDITORIAL_FEEDS = [
    // --- CORE MARKETING ---
    { url: 'https://www.marketingdive.com/feeds/news', source: 'Marketing Dive' },
    { url: 'https://www.campaignlive.co.uk/rss/latest', source: 'Campaign Live' },

    // --- BRANDING & CAMPAIGNS ---
    { url: 'https://www.adweek.com/feed/', source: 'Adweek' },
    { url: 'https://www.moreaboutadvertising.com/feed/', source: 'More About Advertising' },
    { url: 'http://feeds.feedburner.com/Adpulp', source: 'AdPulp' },

    // --- AD TECHNOLOGY ---
    { url: 'https://www.adexchanger.com/feed/', source: 'AdExchanger' },
    { url: 'https://www.adtechdaily.com/feed/', source: 'Ad Tech Daily' },
    { url: 'https://www.videoweek.com/feed/', source: 'VideoWeek' },
    { url: 'https://advertisemint.com/feed/', source: 'AdvertiseMint' },
    { url: 'https://www.ipglab.com/feed/', source: 'IPG Media Lab' },
    { url: 'https://www.silverpush.co/blog/feed/', source: 'SilverPush' },

    // --- FINTECH / ENTERPRISE ---
    { url: 'https://www.ciodive.com/feeds/news/', source: 'CIO Dive' },
    { url: 'https://www.bankingdive.com/feeds/news/', source: 'Banking Dive' },

    // --- TECH & CULTURE ---
    { url: 'https://www.wired.com/feed/rss', source: 'Wired' },
    { url: 'https://www.fastcompany.com/rss', source: 'Fast Company' },
];

const REDDIT_FEEDS = [
    { url: 'https://www.reddit.com/r/marketing.rss', source: 'r/marketing' },
    { url: 'https://www.reddit.com/r/advertising.rss', source: 'r/advertising' },
    { url: 'https://www.reddit.com/r/tech.rss', source: 'r/tech' },
    { url: 'https://www.reddit.com/r/Fintech.rss', source: 'r/fintech' },
    { url: 'https://www.reddit.com/r/userexperience.rss', source: 'r/userexperience' },
];

/**
 * Formats a timestamp into a readable date/time string in EST/EDT
 */
function formatTimestamp(msTimestamp) {
    if (!msTimestamp) return 'N/A';
    return new Date(msTimestamp).toLocaleString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        timeZone: 'America/New_York',
        timeZoneName: 'short'
    });
}

/**
 * Reads the cache file
 */
async function readCache() {
    try {
        const content = await fs.readFile(CACHE_FILE, 'utf8');
        const lines = content.trim().split('\n');

        if (lines.length < 2) {
            console.warn('⚠️  Cache file is corrupted or incomplete.');
            return null;
        }

        const timestamp = parseInt(lines[0], 10);
        const summary = lines.slice(1).join('\n');

        if (isNaN(timestamp)) {
            console.error('❌ Cache file contains an invalid timestamp.');
            return null;
        }

        return { timestamp, summary };
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.error('❌ Error reading cache file:', error);
        }
        return null;
    }
}

/**
 * Writes to the cache file
 */
async function writeCache(timestamp, summary) {
    const content = `${timestamp}\n${summary}`;
    try {
        await fs.writeFile(CACHE_FILE, content, 'utf8');
        console.log('✅ Cache updated');
    } catch (error) {
        console.error('❌ Error writing cache file:', error);
    }
}

/**
 * Updates the feed.xml file with the latest Claude summary
 */
async function updateFeedXML(timestamp, summary) {
    const RFC822_DATE = new Date(timestamp).toUTCString();
    const GUID = `adtech-summary-${new Date(timestamp).toISOString().split('T')[0]}`;
    const escapedSummary = summary.replace(/]]>/g, ']]]]><![CDATA[>');

    const xmlContent = `<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>AdTech News - AI Strategy Summary</title>
    <link>http://localhost:3000</link>
    <description>Claude AI-generated strategic analysis of AdTech, Marketing, and Enterprise Technology news</description>
    <language>en-us</language>
    <lastBuildDate>${RFC822_DATE}</lastBuildDate>
    <atom:link href="http://localhost:3000/feed.xml" rel="self" type="application/rss+xml" />

    <item>
      <title>AI Strategy Summary - AdTech &amp; Marketing News</title>
      <link>http://localhost:3000</link>
      <guid isPermaLink="false">${GUID}</guid>
      <pubDate>${RFC822_DATE}</pubDate>
      <description><![CDATA[
${escapedSummary}

---

**Last Updated**: ${formatTimestamp(timestamp)}

**About This Feed**:
This feed contains AI-generated strategic analysis powered by Claude (Anthropic).
The summary is updated periodically based on aggregated news from Marketing Dive, Adweek, AdExchanger,
VideoWeek, CIO Dive, Banking Dive, Wired, and other industry sources.

**How it works**:
1. The system aggregates news from 15+ industry RSS feeds
2. Claude AI analyzes the content for strategic patterns and insights
3. A structured summary is generated highlighting trends, takeaways, and risks
4. This feed is updated daily via automated GitHub Actions

**Throttling**: To conserve API resources, summaries are generated no more frequently than every ${THROTTLE_MINUTES} minutes.
      ]]></description>
    </item>
  </channel>
</rss>`;

    try {
        await fs.writeFile('feed.xml', xmlContent, 'utf8');
        console.log('✅ feed.xml updated successfully');
    } catch (error) {
        console.error('❌ Error writing feed.xml:', error);
    }
}

/**
 * Fetches a single RSS feed via the rss2json proxy
 */
async function fetchRSSFeed(feedUrl, source) {
    const proxyUrl = `${RSS_TO_JSON_PROXY_BASE}${encodeURIComponent(feedUrl)}`;

    try {
        const response = await fetch(proxyUrl);
        if (!response.ok) {
            console.warn(`⚠️  Failed to fetch ${source}: ${response.status}`);
            return [];
        }

        const data = await response.json();
        if (data.status !== 'ok' || !data.items) {
            console.warn(`⚠️  Invalid response from ${source}`);
            return [];
        }

        // Return items with source attribution
        return data.items.slice(0, 10).map(item => ({
            title: item.title,
            source: source,
            description: item.description || item.content || '',
            link: item.link,
            pubDate: item.pubDate
        }));
    } catch (error) {
        console.warn(`⚠️  Error fetching ${source}:`, error.message);
        return [];
    }
}

/**
 * Fetches all RSS feeds and aggregates them
 */
async function fetchAllFeeds() {
    console.log('📡 Fetching RSS feeds...');

    const allPromises = [
        ...EDITORIAL_FEEDS.map(feed => fetchRSSFeed(feed.url, feed.source)),
        ...REDDIT_FEEDS.map(feed => fetchRSSFeed(feed.url, feed.source))
    ];

    const results = await Promise.all(allPromises);
    const allItems = results.flat();

    console.log(`✅ Fetched ${allItems.length} news items from ${EDITORIAL_FEEDS.length + REDDIT_FEEDS.length} sources`);
    return allItems;
}

/**
 * Formats news items into text content for Claude to analyze
 */
function formatNewsForClaude(items) {
    let content = '# News Articles for Analysis\n\n';

    items.forEach((item, index) => {
        content += `## Article ${index + 1}: ${item.title}\n`;
        content += `**Source:** ${item.source}\n`;
        content += `**Published:** ${item.pubDate || 'Unknown'}\n`;
        content += `**Link:** ${item.link}\n`;
        content += `**Description:**\n${item.description}\n`;
        content += `\n---\n\n`;
    });

    return content;
}

/**
 * Calls Claude API to generate summary
 */
async function generateClaudeSummary(newsContent) {
    if (!apiKey) {
        throw new Error('CLAUDE_API_KEY environment variable is not set');
    }

    const systemPrompt = `
You are a senior strategic analyst specializing in AdTech, Marketing, and Enterprise Technology.
Analyze the following news articles from various industry feeds.

Your task is to:
1. **SCAN** all the provided news articles, extracting key themes and patterns
2. **SYNTHESIZE** the information into strategic insights
3. **GENERATE** a strategic summary in Markdown format

Your output MUST be structured using Markdown headings and lists, focusing on actionable insights, without preamble. Go directly into the following structure:

## 📰 Core Trends & Market Focus
* **[Trend 1/Topic]**: Briefly describe the key theme (e.g., "AI Regulation").
* **[Trend 2/Topic]**: Briefly describe the key theme (e.g., "Retail Media Expansion").
* ... (List 3-5 major recurring themes)

## 💡 Strategic Takeaways for AdTech Leadership
* **For Branding & Campaigns**: What should leadership be doing right now based on the news?
* **For Ad Technology**: What specific technology area requires immediate investment or planning?
* **For Enterprise Tech/FinTech**: What is the key market shift that requires a business response?

## 📉 Potential Risks & Blindspots
* [Risk 1]: A critical risk emerging from the news (e.g., privacy changes, economic downturn, competitor move).
`;

    try {
        console.log('🤖 Calling Claude API for summary generation...');

        const response = await fetch(API_URL, {
            method: 'POST',
            headers: {
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                model: CLAUDE_MODEL,
                max_tokens: 4096,
                system: systemPrompt,
                messages: [
                    { "role": "user", "content": newsContent }
                ]
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`❌ Claude API HTTP Error ${response.status}:`, errorText);
            throw new Error(`Anthropic API request failed with status ${response.status}`);
        }

        const data = await response.json();
        const summary = data.content?.[0]?.text || "Error: Could not extract summary text from Claude response.";

        console.log('✅ Claude summary generated successfully');
        return summary;
    } catch (error) {
        console.error('❌ Claude API Error:', error.message);
        throw error;
    }
}

/**
 * Main execution function
 */
async function main() {
    console.log('🚀 Daily RSS Feed Update - Starting...\n');

    try {
        // Check cache first
        const currentTime = Date.now();
        const cachedData = await readCache();

        if (cachedData) {
            const timeElapsed = currentTime - cachedData.timestamp;

            if (timeElapsed < THROTTLE_MILLISECONDS) {
                const timeRemaining = Math.ceil((THROTTLE_MILLISECONDS - timeElapsed) / (60 * 1000));
                console.log(`⏳ Summary was generated recently at ${formatTimestamp(cachedData.timestamp)}`);
                console.log(`⏳ Next generation available in ${timeRemaining} minutes`);
                console.log(`ℹ️  Using cached summary to update feed.xml`);

                // Update feed.xml with cached summary
                await updateFeedXML(cachedData.timestamp, cachedData.summary);
                console.log('\n✅ Daily update completed (using cached summary)');
                return;
            }
        }

        // Fetch all RSS feeds
        const newsItems = await fetchAllFeeds();

        if (newsItems.length === 0) {
            console.error('❌ No news items fetched. Aborting summary generation.');
            process.exit(1);
        }

        // Format news for Claude
        const formattedNews = formatNewsForClaude(newsItems);

        // Generate Claude summary
        const summary = await generateClaudeSummary(formattedNews);

        // Save to cache and update feed
        const timestamp = Date.now();
        await writeCache(timestamp, summary);
        await updateFeedXML(timestamp, summary);

        console.log(`\n✅ Daily update completed successfully!`);
        console.log(`📅 Generated at: ${formatTimestamp(timestamp)}`);
        console.log(`⏰ Next update: ${formatTimestamp(timestamp + THROTTLE_MILLISECONDS)}`);

    } catch (error) {
        console.error('\n❌ Fatal error during daily update:', error);
        process.exit(1);
    }
}

// Run the script
main();
