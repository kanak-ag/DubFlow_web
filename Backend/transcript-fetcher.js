// =====================================================
//   TRANSCRIPT FETCHER – FIXED WITH TIMING PRESERVATION
// =====================================================

require("dotenv").config();
const { YoutubeTranscript } = require('youtube-transcript');
const { exec } = require('child_process');
const axios = require("axios");
const fs = require('fs');
const path = require('path');

// Retry config
const RETRY_CONFIG = {
    maxRetries: 5,
    baseDelay: 1000,
    maxDelay: 10000,
    backoffFactor: 2
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const calculateRetryDelay = (attempt) =>
    Math.min(RETRY_CONFIG.baseDelay * Math.pow(RETRY_CONFIG.backoffFactor, attempt), RETRY_CONFIG.maxDelay);


// ----------------------------------------------------
// 1) Parse VTT + Merge Duplicate / Incremental Blocks
// ----------------------------------------------------
const parseVttWithMerging = (vttContent) => {
    const blocks = vttContent.split(/\n{2,}/).map(b => b.trim()).filter(Boolean);
    const segments = [];

    const toSeconds = (t) => {
        const [h, m, s] = t.split(':');
        return (+h) * 3600 + (+m) * 60 + parseFloat(s);
    };

    for (const block of blocks) {
        const lines = block.split("\n").map(l => l.trim()).filter(Boolean);
        if (lines.length < 2) continue;

        const timeLine = lines[0];
        if (!/-->/g.test(timeLine)) continue;

        const match = timeLine.match(
            /(\d{2}:\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}\.\d{3})/
        );
        if (!match) continue;

        const [_, startStr, endStr] = match;

        const start = toSeconds(startStr);
        const end = toSeconds(endStr);
        const duration = end - start;

        let text = lines
            .slice(1)
            .join(" ")
            .replace(/<[^>]+>/g, "")    // remove <c>, inline timestamps
            .replace(/\[.*?\]/g, "")    // remove [Music], etc
            .replace(/\s+/g, " ")
            .trim();

        if (!text) continue;

        // MERGE LOGIC → treat blocks within 0.20 sec as same
        if (
            segments.length > 0 &&
            Math.abs(segments[segments.length - 1].start - start) < 0.20
        ) {
            const prev = segments[segments.length - 1];

            if (text.length > prev.text.length) {
                prev.text = text;
                prev.duration = duration;
            }

            continue;
        }

        segments.push({ text, start, duration });
    }

    return segments;
};


// ----------------------------------------------------
// 2) LLM Clean Text While Preserving Timing
// ----------------------------------------------------
const llmCleanWithTiming = async (segments) => {
    try {
        // Combine all text for cleaning
        const fullText = segments.map(s => s.text).join(" ");
        
        const response = await axios.post(
            "https://openrouter.ai/api/v1/chat/completions",
            {
                model: "meta-llama/llama-3-70b-instruct",
                messages: [
                    {
                        role: "system",
                        content:
"Clean this YouTube transcript: remove duplicates, fix grammar, remove filler words. Keep the meaning intact. Output ONLY the cleaned text, no extra commentary."
                    },
                    {
                        role: "user",
                        content: fullText
                    }
                ]
            },
            {
                headers: {
                    "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
                    "HTTP-Referer": "http://localhost:3000",
                    "Content-Type": "application/json"
                }
            }
        );

        const cleanedText = response.data.choices[0].message.content.trim();
        
        // Split cleaned text into sentences
        const cleanedSentences = cleanedText
            .split(/(?<=[.!?])\s+/)
            .filter(x => x.trim().length > 0)
            .map(t => t.trim());

        // Map cleaned sentences back to original timing
        // Strategy: distribute cleaned sentences across original time segments
        const result = [];
        const timePerSentence = segments.reduce((sum, s) => sum + s.duration, 0) / cleanedSentences.length;
        
        let currentTime = segments[0]?.start || 0;
        
        for (const sentence of cleanedSentences) {
            result.push({
                text: sentence,
                start: currentTime,
                duration: timePerSentence
            });
            currentTime += timePerSentence;
        }

        return result;

    } catch (err) {
        console.log("⚠️ LLM cleanup failed, using original timing:", err.message);
        // Return original segments if LLM fails
        return segments;
    }
};


// ----------------------------------------------------
// 3) Try to fetch via YouTubeTranscript library first
// ----------------------------------------------------
const fetchTranscriptWithRetry = async (videoId) => {
    console.log(`🔍 Trying primary transcript fetch for: ${videoId}`);
    let lastError = null;

    for (let attempt = 0; attempt < RETRY_CONFIG.maxRetries; attempt++) {
        try {
            const transcript = await YoutubeTranscript.fetchTranscript(videoId);

            if (transcript?.length > 0) {
                console.log(`✅ Primary fetch successful: ${transcript.length} segments`);
                return transcript.map(item => ({
                    text: item.text,
                    start: item.offset / 1000,
                    duration: item.duration / 1000
                }));
            }

        } catch (err) {
            lastError = err;
            console.log(`❌ Primary fetch attempt ${attempt + 1} failed:`, err.message);
            await sleep(calculateRetryDelay(attempt));
        }
    }

    console.log("⚠️ Falling back to yt-dlp extractor…");
    return await tryYtDlpFallback(videoId);
};


// ----------------------------------------------------
// 4) Main public function – used by backend
// ----------------------------------------------------
const fetchTranscript = async (videoId) => {
    if (!videoId || typeof videoId !== "string" || videoId.length !== 11) {
        throw new Error("Invalid YouTube Video ID");
    }

    return await fetchTranscriptWithRetry(videoId);
};


// ----------------------------------------------------
// 5) Validate transcript availability
// ----------------------------------------------------
const validateTranscriptAvailability = async (videoId) => {
    try {
        const transcript = await fetchTranscript(videoId);
        return {
            available: true,
            segmentCount: transcript.length,
            preview: transcript.slice(0, 5).map(x => x.text).join(" ")
        };
    } catch (err) {
        return { available: false, error: err.message };
    }
};


// ----------------------------------------------------
// 6) yt-dlp fallback → VTT extract → merge → PRESERVE TIMING
// ----------------------------------------------------
const tryYtDlpFallback = (videoId) => {
    return new Promise((resolve, reject) => {

        const tempDir = path.join(__dirname, "temp");
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

        const outputFile = path.join(tempDir, `${videoId}.en.vtt`);

        const command =
            `yt-dlp --write-auto-sub --skip-download --sub-lang en ` +
            `--output "${tempDir}/%(id)s.%(ext)s" "https://www.youtube.com/watch?v=${videoId}"`;

        exec(command, async (error, stdout, stderr) => {

            if (error) return reject(new Error("yt-dlp failed: " + error.message));

            if (!fs.existsSync(outputFile))
                return reject(new Error("No subtitles generated"));

            const vttContent = fs.readFileSync(outputFile, "utf8");

            // STEP 1: Parse VTT with timing preservation
            let segments = parseVttWithMerging(vttContent);
            console.log(`📝 Parsed ${segments.length} segments from VTT`);

            // STEP 2: Clean text while preserving timing structure
            let finalSegments = await llmCleanWithTiming(segments);
            console.log(`✨ Cleaned to ${finalSegments.length} segments`);

            // Debug: Log first few segments with timing
            console.log("\n📊 Sample segments:");
            finalSegments.slice(0, 3).forEach((s, i) => {
                console.log(`  [${i}] ${s.start.toFixed(2)}s - ${(s.start + s.duration).toFixed(2)}s: "${s.text.substring(0, 50)}..."`);
            });

            // Save cleaned text for debugging
            fs.writeFileSync(
                path.join(tempDir, `${videoId}_cleaned.txt`),
                finalSegments.map(s => `[${s.start.toFixed(2)}s] ${s.text}`).join("\n")
            );

            return resolve(finalSegments);
        });
    });
};


// ----------------------------------------------------
// EXPORTS
// ----------------------------------------------------
module.exports = {
    fetchTranscript,
    fetchTranscriptWithRetry,
    validateTranscriptAvailability,
    RETRY_CONFIG
};