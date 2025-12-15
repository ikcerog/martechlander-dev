// server.js

const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs/promises'); // Use promises version of fs for async/await
const { GoogleGenAI } = require("@google/genai");

// Load environment variables locally
require('dotenv').config(); 

const app = express();
const port = process.env.PORT || 3000;

// Caching and Throttling Configuration
const CACHE_FILE = 'summary_cache.txt';
const THROTTLE_MINUTES = 91;
const THROTTLE_MILLISECONDS = THROTTLE_MINUTES * 60 * 1000; // 91 minutes in milliseconds

const apiKey = process.env.GEMINI_API_KEY;
const ai = new GoogleGenAI({ apiKey: apiKey });

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
 * Formats a timestamp into a readable date/time string.
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
        // --- FORCE EST/EDT ---
        timeZone: 'America/New_York', 
        timeZoneName: 'short'
    });
}


// 1. Serve the main HTML file
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});


// 2. AI Summary Endpoint (Modified for Caching/Throttling)
app.post('/api/summarize-news', async (req, res) => {
    const htmlContent = req.body.htmlContent;
    const currentTime = Date.now();
    let cachedData = await readCache();
    let summaryToReturn = null;

    if (cachedData) {
        const timeElapsed = currentTime - cachedData.timestamp;

        if (timeElapsed < THROTTLE_MILLISECONDS) {
            // --- THROTTLED: RETURN CACHED SUMMARY ---
            const timeRemaining = THROTTLE_MILLISECONDS - timeElapsed;
            const nextRunTime = cachedData.timestamp + THROTTLE_MILLISECONDS;

            const cacheHeader = `
                ## ⏳ Summary Throttle Active ⏳
                This summary was last generated at **${formatTimestamp(cachedData.timestamp)}**.
                The next beneficial generation time is **${formatTimestamp(nextRunTime)}** (in ${Math.ceil(timeRemaining / (60 * 1000))} minutes).
                The AI model was not called to conserve API resources.
                ---
            `;
            
            summaryToReturn = cacheHeader + cachedData.summary;

        } else {
            // --- THROTTLING WINDOW EXPIRED: GENERATE NEW SUMMARY ---
            console.log('Throttle window expired. Calling Gemini API...');
        }
    } else {
        // --- NO CACHE FILE: GENERATE NEW SUMMARY (First Run) ---
        console.log('No cache file found. Calling Gemini API for the first time...');
    }
    
    // If summaryToReturn is still null, it means we need to call the API
    if (!summaryToReturn) {
        if (!htmlContent) {
            return res.status(400).json({ error: 'Missing HTML content in request body.' });
        }

        const modelName = "gemini-2.5-flash"; 
        // Note: The inputPrompt remains the same for analysis.
        const inputPrompt = `
            You are a senior strategic analyst specializing in AdTech, Marketing, and Enterprise Technology.
            Your task is to analyze the following HTML content, which contains recent news articles from various industry feeds.

            1. **SCAN** the provided HTML content for all titles, sources, and descriptions within the '.news-card' elements.
            2. **IGNORE** all hidden elements or administrative content (like 'Hide Forever' buttons).
            3. **GENERATE** a strategic summary in Markdown format that is ready to be directly displayed in a dashboard panel.

            Your output MUST be structured using Markdown headings and lists, focusing on actionable insights:

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
            
            // Save the new summary and timestamp to the cache
            await writeCache(newTimestamp, newSummary);

            // Construct the header for the *new* summary output
            const newCacheHeader = `
                ## ✅ Summary Freshly Generated ✅
                This summary was generated **just now** at **${formatTimestamp(newTimestamp)}**.
                The next beneficial generation time will be **${formatTimestamp(newTimestamp + THROTTLE_MILLISECONDS)}**.
                ---
            `;

            summaryToReturn = newCacheHeader + newSummary;

        } catch (error) {
            console.error("Gemini API Error:", error);
            return res.status(500).json({ error: 'Failed to generate AI summary. Check server logs.' });
        }
    }

    res.json({ summary: summaryToReturn });
});


// Start the server
app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});
