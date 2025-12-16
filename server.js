// server.js

const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
// const fs = require('fs/promises'); // REMOVED: No longer used for local file caching
const { GoogleGenAI } = require("@google/genai");

// --- NEW: Caching Dependency ---
const Redis = require('ioredis'); 
// -------------------------------

// Load environment variables locally (Render ignores this but it's good for local testing)
require('dotenv').config(); 

const app = express();
const port = process.env.PORT || 3000;

// Caching and Throttling Configuration
const CACHE_KEY_SUMMARY = 'latest_strategic_summary';
const CACHE_KEY_TIMESTAMP = 'latest_strategic_timestamp';

const THROTTLE_MINUTES = 91;
const THROTTLE_SECONDS = THROTTLE_MINUTES * 60; // 91 minutes in seconds (for Redis TTL)
const THROTTLE_MILLISECONDS = THROTTLE_MINUTES * 60 * 1000; // 91 minutes in milliseconds

// --- NEW: Redis Client Connection and Safety Check ---
const redisUrl = process.env.REDIS_URL;
let redisClient = null; // Initialize as null

if (redisUrl) {
    try {
        // Initialize the client only if the URL is present
        redisClient = new Redis(redisUrl); 

        redisClient.on('connect', () => console.log('Redis Client Connected Successfully.'));
        // Defensive error handler to prevent crashing, allowing the app to run without cache
        redisClient.on('error', (err) => {
            console.error('Redis Client Error: Caching disabled.', err.message);
            // Optionally, set client to null here if the error is terminal
        });
    } catch (e) {
        console.error('Failed to initialize Redis client:', e.message);
        redisClient = null;
    }
} else {
    console.warn('REDIS_URL environment variable is missing. Caching will use non-persistent memory (local file fallback is gone).');
}
// ----------------------------------------------------

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
    // Safety check: If Redis is unavailable, treat it as a cache miss.
    if (!redisClient) return null; 
    
    try {
        // Fetch both the timestamp and the summary content from Redis
        const [timestampStr, summary] = await redisClient.mget(CACHE_KEY_TIMESTAMP, CACHE_KEY_SUMMARY);

        if (!timestampStr || !summary) {
            return null;
        }
        
        const timestamp = parseInt(timestampStr, 10);

        if (isNaN(timestamp)) {
            console.error('Redis cache contains an invalid timestamp.');
            return null;
        }

        return { timestamp, summary };
    } catch (error) {
        console.error('Error reading from Redis:', error.message);
        return null; // Treat any Redis error as a cache miss
    }
}

/**
 * Writes the new timestamp and summary to Redis with a TTL (Time-To-Live).
 * @param {number} timestamp 
 * @param {string} summary 
 * @returns {Promise<void>}
 */
async function writeCache(timestamp, summary) {
    // Safety check: If Redis is unavailable, do nothing.
    if (!redisClient) return; 

    try {
        const timestampStr = timestamp.toString();

        // Use a transaction (multi/exec) to ensure both keys are set together
        await redisClient.multi()
            .set(CACHE_KEY_TIMESTAMP, timestampStr)
            .set(CACHE_KEY_SUMMARY, summary, 'EX', THROTTLE_SECONDS)
            .exec();
        
        console.log(`New summary cached in Redis for ${THROTTLE_MINUTES} minutes.`);
    } catch (error) {
        console.error('Error writing to Redis:', error.message);
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
            console.log('Generating summary via Gemini API...');
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
            // Handle API call failure
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
