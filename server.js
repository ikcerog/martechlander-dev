// server.js

const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs/promises'); 
// For making the HTTPS request to Anthropic. Handles potential Node module exports.
const fetch = require('node-fetch').default || require('node-fetch'); 

// Load environment variables locally (Render ignores this but it's good for local testing)
require('dotenv').config(); 

const app = express();
const port = process.env.PORT || 3000;

// Caching and Throttling Configuration
const CACHE_FILE = 'summary_cache.txt';
const THROTTLE_MINUTES = 91;
const THROTTLE_MILLISECONDS = THROTTLE_MINUTES * 60 * 1000; 

// --- ANTHROPIC CONFIGURATION ---
// Ensure the API key is read and any accidental whitespace is trimmed
const apiKey = process.env.CLAUDE_API_KEY ? process.env.CLAUDE_API_KEY.trim() : null; 

// Using Claude Sonnet 4.5 (released Sept 29, 2025)
const CLAUDE_MODEL = "claude-sonnet-4-5-20250929"; 
const API_URL = "https://api.anthropic.com/v1/messages";

if (!apiKey) {
    console.error("FATAL: CLAUDE_API_KEY environment variable is missing.");
}
// -------------------------------

// Middleware setup
app.use(bodyParser.json({ limit: '50mb' })); 
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public'))); 


/**
 * Reads the cache file and returns the timestamp and summary.
 * @returns {Promise<{timestamp: number, summary: string}|null>}
 */
async function readCache() {
    try {
        const content = await fs.readFile(CACHE_FILE, 'utf8');
        const lines = content.trim().split('\n');
        
        if (lines.length < 2) {
            console.warn('Cache file is corrupted or incomplete.');
            return null;
        }

        const timestamp = parseInt(lines[0], 10);
        const summary = lines.slice(1).join('\n');

        if (isNaN(timestamp)) {
            console.error('Cache file contains an invalid timestamp.');
            return null;
        }

        return { timestamp, summary };
    } catch (error) {
        // File not found is expected on first run
        if (error.code !== 'ENOENT') {
            console.error('Error reading cache file:', error);
        }
        return null;
    }
}

/**
 * Writes the new timestamp and summary to the cache file.
 * @param {number} timestamp 
 * @param {string} summary 
 * @returns {Promise<void>}
 */
async function writeCache(timestamp, summary) {
    const content = `${timestamp}\n${summary}`;
    try {
        await fs.writeFile(CACHE_FILE, content, 'utf8');
    } catch (error) {
        console.error('Error writing cache file:', error);
    }
}

/**
 * Formats a timestamp into a readable date/time string, forcing EST/EDT.
 * @param {number} msTimestamp 
 * @returns {string}
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
        timeZone: 'America/New_York', // Force EST/EDT
        timeZoneName: 'short'
    });
}

/**
 * Updates the feed.xml file with the latest Claude summary
 * @param {number} timestamp
 * @param {string} summary
 * @returns {Promise<void>}
 */
async function updateFeedXML(timestamp, summary) {
    const RFC822_DATE = new Date(timestamp).toUTCString();
    const GUID = `adtech-summary-${new Date(timestamp).toISOString().split('T')[0]}`;

    // Escape the summary content for XML CDATA
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
1. The system aggregates news from 10+ industry RSS feeds
2. Claude AI analyzes the content for strategic patterns and insights
3. A structured summary is generated highlighting trends, takeaways, and risks
4. This feed is updated when new analysis is available

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


// 1. Serve the main HTML file
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// 2. Serve the RSS/XML feed file
app.get('/feed.xml', (req, res) => {
    res.set('Content-Type', 'application/rss+xml');
    res.sendFile(path.join(__dirname, 'feed.xml'));
});


// 3. AI Summary Endpoint (Caching/Throttling logic KEPT, API call changed)
app.post('/api/summarize-news', async (req, res) => {
    const htmlContent = req.body.htmlContent;
    const forceRegenerate = req.body.forceRegenerate || false;
    const currentTime = Date.now();
    let cachedData = await readCache();
    let summaryToReturn = null;
    let headerToReturn = null;

    if (cachedData && !forceRegenerate) {
        const timeElapsed = currentTime - cachedData.timestamp;

        if (timeElapsed < THROTTLE_MILLISECONDS) {
            // --- THROTTLED: RETURN CACHED SUMMARY ---
            const timeRemaining = THROTTLE_MILLISECONDS - timeElapsed;
            const nextRunTime = cachedData.timestamp + THROTTLE_MILLISECONDS;

            headerToReturn = `
                ## ⏳ Summary Throttle Active ⏳
                This summary was last generated at **${formatTimestamp(cachedData.timestamp)}**.
                The next beneficial generation time is **${formatTimestamp(nextRunTime)}** (in ${Math.ceil(timeRemaining / (60 * 1000))} minutes).
                The AI model was not called, to conserve the finite API interactions per day.
                ---
            `;

            summaryToReturn = cachedData.summary; // Return CLEAN summary

            // Ensure the XML feed is up to date with cached summary
            await updateFeedXML(cachedData.timestamp, cachedData.summary);

        } else {
            // --- THROTTLING WINDOW EXPIRED: GENERATE NEW SUMMARY ---
            console.log('Throttle window expired. Calling Claude API...');
        }
    } else {
        // --- NO CACHE FILE: GENERATE NEW SUMMARY (First Run) ---
        console.log('No cache file found. Calling Claude API for the first time...');
    }
    
    // If summaryToReturn is still null, it means we need to call the API
    if (!summaryToReturn) {
        if (!htmlContent) {
            return res.status(400).json({ error: 'Missing HTML content in request body.' });
        }
        if (!apiKey) {
            return res.status(500).json({ error: 'CLAUDE_API_KEY environment variable is not set.' });
        }


        // --- ANTHROPIC API CALL LOGIC ---
        const systemPrompt = `
            You are a senior strategic analyst specializing in AdTech, Marketing, and Enterprise Technology.
            Analyze the following HTML content, which contains recent news articles from various industry feeds.

            Your task is to:
            1. **SCAN** the provided HTML content for all titles, sources, and descriptions within the '.news-card' elements.
            2. **IGNORE** all hidden elements or administrative content (like 'Hide Forever' buttons).
            3. **GENERATE** a strategic summary in Markdown format that is ready to be directly displayed in a dashboard panel.

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

        const userContent = `
            ---
            HTML Content to Analyze:
            ---
            ${htmlContent}
        `;

        try {
            console.log(`Making API call to Claude (ID: ${CLAUDE_MODEL})...`);
            
            const response = await fetch(API_URL, {
                method: 'POST',
                headers: {
                    'x-api-key': apiKey,
                    'anthropic-version': '2023-06-01', // Required API version
                    'content-type': 'application/json'
                },
                body: JSON.stringify({
                    model: CLAUDE_MODEL,
                    max_tokens: 4096,
                    system: systemPrompt, 
                    messages: [
                        { "role": "user", "content": userContent }
                    ]
                })
            });

            if (!response.ok) {
                const errorText = await response.text();
                console.error(`Claude API HTTP Error ${response.status}:`, errorText);
                throw new Error(`Anthropic API request failed with status ${response.status}: ${errorText}`);
            }

            const data = await response.json();
            
            // Extract the summary text from Claude's response structure
            const newSummary = data.content?.[0]?.text || "Error: Could not extract summary text from Claude response.";
            const newTimestamp = Date.now();

            // Save the new summary and timestamp to the cache
            await writeCache(newTimestamp, newSummary);

            // Update the XML feed with the new summary
            await updateFeedXML(newTimestamp, newSummary);

            // Construct the header for the *new* summary output
            headerToReturn = `
                ## ✅ Summary Freshly Generated by Claude ✅
                This summary was generated **just now** at **${formatTimestamp(newTimestamp)}**.
                The next beneficial generation time will be **${formatTimestamp(newTimestamp + THROTTLE_MILLISECONDS)}**.
                ---
            `;

            summaryToReturn = newSummary; // Return CLEAN summary

        } catch (error) {
            console.error("Claude API Error:", error.message);
            return res.status(500).json({ error: `Failed to generate AI summary: ${error.message}` });
        }
    }
    
    // Return two separate fields: the status header and the clean summary content.
    res.json({ 
        header: headerToReturn,
        summary: summaryToReturn 
    });
});


// Start the server
app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});
