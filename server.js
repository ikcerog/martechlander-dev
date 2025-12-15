// server.js (Focusing on the /api/summarize-news endpoint)

// ... (Requires, Globals, and Helper functions like readCache, writeCache, formatTimestamp are unchanged) ...

// 2. AI Summary Endpoint (Modified for Caching/Throttling)
app.post('/api/summarize-news', async (req, res) => {
    const htmlContent = req.body.htmlContent;
    const currentTime = Date.now();
    let cachedData = await readCache();
    let summaryToReturn = null;
    let headerToReturn = null; // New variable for the header

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
                The AI model was not called to conserve API resources.
                ---
            `;
            
            summaryToReturn = cachedData.summary; // Return CLEAN summary

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
        const inputPrompt = `
            // ... (Your existing large prompt content here) ...
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
            headerToReturn = `
                ## ✅ Summary Freshly Generated ✅
                This summary was generated **just now** at **${formatTimestamp(newTimestamp)}**.
                The next beneficial generation time will be **${formatTimestamp(newTimestamp + THROTTLE_MILLISECONDS)}**.
                ---
            `;

            summaryToReturn = newSummary; // Return CLEAN summary

        } catch (error) {
            console.error("Gemini API Error:", error);
            return res.status(500).json({ error: 'Failed to generate AI summary. Check server logs.' });
        }
    }
    
    // --- CHANGE: Return two separate fields ---
    res.json({ 
        header: headerToReturn,
        summary: summaryToReturn 
    });
});

// ... (Rest of server.js) ...
