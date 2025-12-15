// server.js

const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const { GoogleGenAI } = require("@google/genai");

// Load environment variables locally (Render ignores this but it's good for local testing)
require('dotenv').config(); 

const app = express();
const port = process.env.PORT || 3000;

// --- CRITICAL FIX FOR RENDER DEPLOYMENT ---
// The API key is now explicitly passed to the GoogleGenAI constructor,
// ensuring it works on Render (via environment variable) and locally (via .env file).
const apiKey = process.env.GEMINI_API_KEY;
const ai = new GoogleGenAI({ apiKey: apiKey });
// ------------------------------------------

// Middleware setup
app.use(bodyParser.json({ limit: '50mb' })); // Increased limit for the large HTML content
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public'))); // If you were using a public folder

// 1. Serve the main HTML file
app.get('/', (req, res) => {
    // __dirname is the current directory of server.js
    res.sendFile(path.join(__dirname, 'index.html'));
});


// 2. AI Summary Endpoint
app.post('/api/summarize-news', async (req, res) => {
    const htmlContent = req.body.htmlContent;

    if (!htmlContent) {
        return res.status(400).json({ error: 'Missing HTML content in request body.' });
    }

    // --- PROMPT ENGINEERING ---
    // The key part of this function. We instruct Gemini to analyze the scraped content.

    const modelName = "gemini-2.5-flash"; // Fast and capable model for text analysis
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

        // The response text is the summary, structured by the prompt.
        const summary = response.text;

        res.json({ summary: summary });
    } catch (error) {
        console.error("Gemini API Error:", error);
        res.status(500).json({ error: 'Failed to generate AI summary. Check server logs.' });
    }
});


// Start the server
app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});
