// server.js

const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
// const fs = require('fs/promises'); // REMOVED: No longer needed for local file caching
const { GoogleGenAI } = require("@google/genai");
// --- NEW: Caching Dependency ---
const Redis = require('ioredis'); 
// -------------------------------

// Load environment variables locally (Render ignores this but it's good for local testing)
require('dotenv').config(); 

const app = express();
const port = process.env.PORT || 3000;

// --- NEW: Redis Client Connection ---
// Render automatically provides a REDIS_URL for your Redis instance
const redisClient = new Redis(process.env.REDIS_URL); 

redisClient.on('connect', () => console.log('Redis Client Connected Successfully.'));
redisClient.on('error', (err) => console.error('Redis Client Error:', err));
// ------------------------------------

// Caching and Throttling Configuration
// const CACHE_FILE = 'summary_cache.txt'; // REMOVED: Replaced by Redis key
const CACHE_KEY_SUMMARY = 'latest_strategic_summary';
const CACHE_KEY_TIMESTAMP = 'latest_strategic_timestamp';

const THROTTLE_MINUTES = 91;
const THROTTLE_SECONDS = THROTTLE_MINUTES * 60; // 91 minutes in seconds (for Redis TTL)
const THROTTLE_MILLISECONDS = THROTTLE_MINUTES * 60 * 1000; // 91 minutes in milliseconds (for time comparisons)

// The API key is now explicitly passed to the GoogleGenAI constructor,
const apiKey = process.env.GEMINI_API_KEY;
const ai = new GoogleGenAI({ apiKey: apiKey });

// Middleware setup
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public'))); 


/**
 * Reads the cache data (timestamp and summary) from Redis.
 * @returns {Promise<{timestamp: number, summary: string}|null>}
 */
async function readCache() {
    try {
        // Fetch both the timestamp and the summary content from Redis
        const [timestampStr, summary] = await redisClient.mget(CACHE_KEY_TIMESTAMP, CACHE_KEY_SUMMARY);

        if (!timestampStr || !summary) {
            console.log('Redis cache miss or incomplete data.');
            return null;
        }
        
        const timestamp = parseInt(timestampStr, 10);

        if (isNaN(timestamp)) {
            console.error('Redis cache contains an invalid timestamp.');
            return null;
        }

        return { timestamp, summary };
    } catch (error) {
        console.error('Error reading from Redis:', error);
        return null; // Treat any Redis error as a cache miss
    }
}

/**
 * Writes the new timestamp and summary to Redis with a TTL (Time-To-Live).
 * We set the summary TTL to match the throttle time. The timestamp is just a number.
 * @param {number} timestamp 
 * @param {string} summary 
 * @returns {Promise<void>}
 */
async function writeCache(timestamp, summary) {
    try {
        // Use a multi-set (mset) with transaction (multi) for atomicity if needed, 
        // but for simplicity, we use two SET commands here.
        // We set the TTL only on the summary to ensure the timestamp is always current
        // or we can set the TTL on both to keep them synchronized.
        const timestampStr = timestamp.toString();

        // 1. Store the timestamp (no TTL needed, it's just a number)
        await redisClient.set(CACHE_KEY_TIMESTAMP, timestampStr);
        
        // 2. Store the summary content with an explicit TTL (Time To Live)
        await redisClient.set(CACHE_KEY_SUMMARY, summary, 'EX', THROTTLE_SECONDS);
        
        console.log(`New summary cached in Redis for ${THROTTLE_MINUTES} minutes.`);
    } catch (error) {
        console.error('Error writing to Redis:', error);
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


// 1. Serve the main HTML file
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});


// 2. AI Summary Endpoint (Modified for Caching/Throttling and separate output)
app.post('/api/summarize-news', async (req, res) => {
    const htmlContent = req.body.htmlContent;
    const currentTime = Date.now();
    
    // --- STEP 1: Check Redis Cache ---
    let cachedData = await readCache();
    let summaryToReturn = null;
    let headerToReturn = null;

    if (cachedData) {
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

        } else {
            // --- THROTTLING WINDOW EXPIRED: GENERATE NEW SUMMARY ---
            console.log('Throttle window expired. Calling Gemini API...');
        }
    } else {
        // --- NO CACHE DATA: GENERATE NEW SUMMARY (First Run or Cache Expired) ---
        console.log('No cache data found in Redis. Calling Gemini API for the first time or due to expiration...');
    }
    
    // If summaryToReturn is still null, it means we need to call the API
    if (!summaryToReturn) {
        if (!htmlContent) {
            return res.status(400).json({ error: 'Missing HTML content in request body.' });
        }

        const modelName = "gemini-2.5-flash"; 
        // This input prompt remains consistent with the user's initial structure
        const inputPrompt = `
            Provide perspective from the vantage of a senior strategic analyst specializing in AdTech, Marketing, and Enterprise Technology.
            Analyze the following HTML content, which contains recent news articles from various industry feeds.

            1. **SCAN** the provided HTML content for all titles, sources, and descriptions within the '.news-card' elements.
            2. **IGNORE** all hidden elements or administrative content (like 'Hide Forever' buttons).
            3. **GENERATE** a strategic summary in Markdown format that is ready to be directly displayed in a dashboard panel.

            Your output MUST be structured using Markdown headings and lists, focusing on actionable insights, without preamble go directly into:

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

            ---
            HTML Content to Analyze:
            ---
            ${htmlContent}
        `;
        
        try {
            const response = await ai.models.generateContent({
                model: modelName,
                contents: inputPrompt,
            });

            const newSummary = response.text;
            const newTimestamp = Date.now();
            
            // --- STEP 2: Save the new summary and timestamp to Redis ---
            await writeCache(newTimestamp, newSummary);

            // Construct the header for the *new* summary output
            headerToReturn = `
                ## ✅ Summary Freshly Generated ✅
                This summary was generated **just now** at **${formatTimestamp(newTimestamp)}**.
                The next beneficial generation time will be **${formatTimestamp(newTimestamp + THROTTLE_MILLISECONDS)}**.
                ---
            `;

            summaryToReturn = newSummary; // Return CLEAN summary

        } catch (error) {
            console.error("Gemini API Error:", error);
            // Include Redis errors here as well
            return res.status(500).json({ error: 'Failed to generate AI summary. Check server logs.' });
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
