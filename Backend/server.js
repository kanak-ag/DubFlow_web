// server.js - DubFlow (Fixed Timeline Version)
// ------------------------------------------------------------
// This version correctly handles audio timing with proper
// silence gaps and initial offset
// ------------------------------------------------------------

const express = require('express');
const cors = require('cors');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const axios = require('axios');
const gTTS = require('gtts');
const { ElevenLabsClient } = require('elevenlabs');
const { v4: uuidv4 } = require('uuid');
const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

// Clean transcript to remove duplicate consecutive lines
function cleanTranscriptArray(arr) {
  const cleaned = [];
  let last = "";

  for (let item of arr) {
    const text = item.text.trim();
    if (!text) continue;

    if (text !== last) {
      cleaned.push(item);
      last = text;
    }
  }

  return cleaned;
}

// Import transcript fetcher
const { fetchTranscript, validateTranscriptAvailability } = require('./transcript-fetcher');

const app = express();
const PORT = process.env.PORT || 3001;
require('dotenv').config();

// --- Standard audio config ---
const STANDARD_SAMPLE_RATE = 22050;
const STANDARD_CHANNELS = 1;
const STANDARD_AUDIO_FORMAT = 'wav';

// RapidAPI Translator
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
const RAPIDAPI_HOST = 'google-translator9.p.rapidapi.com';
let translatorAvailable = !!RAPIDAPI_KEY;

// Log translator status on startup
console.log(`🔑 Translator Status: ${translatorAvailable ? 'ENABLED' : 'DISABLED'} (RAPIDAPI_KEY ${RAPIDAPI_KEY ? 'SET' : 'MISSING'})`);

// ElevenLabs TTS Configuration
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
let elevenLabsAvailable = !!ELEVENLABS_API_KEY;
let elevenLabsClient = null;

if (elevenLabsAvailable) {
  try {
    // Try global endpoint first
    elevenLabsClient = new ElevenLabsClient({ apiKey: ELEVENLABS_API_KEY });
    console.log(`🔊 ElevenLabs Status: ENABLED (API Key Set)`);
  } catch (err) {
    console.log(`❌ ElevenLabs initialization failed: ${err.message}`);
    elevenLabsAvailable = false;
  }
} else {
  console.log(`🔊 ElevenLabs Status: DISABLED`);
}

// Soniox TTS Configuration
const SONIOX_API_KEY = process.env.SONIOX_API_KEY;
let sonioxAvailable = !!SONIOX_API_KEY;

if (sonioxAvailable) {
  console.log(`🔊 Soniox Status: ENABLED (API Key Set)`);
} else {
  console.log(`🔊 Soniox Status: DISABLED`);
}

// Middleware
app.use(cors());
app.use(express.json());
app.use('/downloads', express.static(path.join(__dirname, 'downloads')));

// Ensure downloads folder exists
const ensureDownloadsDir = async () => {
  const d = path.join(__dirname, 'downloads');
  try { await fs.access(d); } catch { await fs.mkdir(d, { recursive: true }); }
};

// Extract YouTube ID
const extractVideoId = (url) => {
  const regex = /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/;
  const match = url.match(regex);
  return match ? match[1] : null;
};

// Language code mapping
const getRapidApiLanguageCode = (language) => {
  const map = {
    'spanish': 'es','french': 'fr','german': 'de','italian': 'it','portuguese': 'pt',
    'hindi': 'hi','japanese': 'ja','korean': 'ko','chinese': 'zh-CN','english': 'en',
    'bengali': 'bn','telugu': 'te','marathi': 'mr','tamil': 'ta','gujarati': 'gu',
    'kannada': 'kn','malayalam': 'ml','punjabi': 'pa','urdu': 'ur'
  };
  return map[language.toLowerCase()] || language.toLowerCase();
};

// Translate text
const translateText = async (text, targetLanguage) => {
  try {
    if (!translatorAvailable) {
      console.log(`⚠️  Translator not available - returning original text: "${text.substring(0, 30)}..."`);
      return text;
    }

    const targetLangCode = getRapidApiLanguageCode(targetLanguage);
    console.log(`🔄 Translating to ${targetLanguage} (${targetLangCode}): "${text.substring(0, 40)}..."`);

    const response = await axios.post(
      'https://google-translator9.p.rapidapi.com/v2',
      {
        q: text.trim(),
        source: 'auto',
        target: targetLangCode,
        format: 'text'
      },
      {
        headers: {
          'x-rapidapi-key': RAPIDAPI_KEY,
          'x-rapidapi-host': RAPIDAPI_HOST,
          'Content-Type': 'application/json'
        }
      }
    );

    const translated = response.data?.data?.translations?.[0]?.translatedText || text;
    console.log(`✅ Translated: "${translated.substring(0, 40)}..."`);
    return translated;
  } catch (err) {
    console.warn('❌ Translation API failed:', err.message);
    return text;
  }
};

// Batch translate
const batchTranslateText = async (arr, targetLanguage) => {
  console.log(`📢 Starting batch translation of ${arr.length} segments to ${targetLanguage}`);
  const result = [];
  let errorCount = 0;

  for (let i = 0; i < arr.length; i++) {
    const item = arr[i];
    const translated = await translateText(item.text, targetLanguage);
    result.push({ ...item, translatedText: translated });

    // Check if translation actually happened
    if (translated === item.text) {
      errorCount++;
    }

    if ((i + 1) % 10 === 0) {
      console.log(`   Progress: ${i + 1}/${arr.length} segments processed`);
    }

    await new Promise(r => setTimeout(r, 150));
  }

  console.log(`📊 Translation complete: ${arr.length - errorCount}/${arr.length} segments translated successfully`);
  return result;
};

// Normalize to standard WAV
const normalizeAudioToStandardWav = async (input, output) => {
  return new Promise((resolve, reject) => {
    ffmpeg(input)
      .audioCodec('pcm_s16le')
      .audioChannels(STANDARD_CHANNELS)
      .audioFrequency(STANDARD_SAMPLE_RATE)
      .format(STANDARD_AUDIO_FORMAT)
      .on('end', () => resolve(output))
      .on('error', reject)
      .save(output);
  });
};

// Silence generator
const createSilence = async (duration, outputPath) => {
  return new Promise(async (resolve, reject) => {
    try {
      const samples = Math.floor(duration * STANDARD_SAMPLE_RATE);
      const bytes = samples * STANDARD_CHANNELS * 2;
      const rawPath = outputPath.replace('.wav', '.raw');

      fsSync.writeFileSync(rawPath, Buffer.alloc(bytes, 0));
      await execAsync(`ffmpeg -y -f s16le -ar ${STANDARD_SAMPLE_RATE} -ac ${STANDARD_CHANNELS} -i "${rawPath}" "${outputPath}"`);
      fsSync.unlinkSync(rawPath);
      resolve(outputPath);
    } catch (err) {
      reject(err);
    }
  });
};

// ATEMPO 1.6x operation
const apply2xSpeed = async (inputPath, outputPath) => {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .audioFilters('atempo=1.5')
      .output(outputPath)
      .on('end', () => resolve(outputPath))
      .on('error', reject)
      .run();
  });
};

// Get duration
const getAudioDuration = (file) => {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(file, (err, meta) => {
      if (err) reject(err);
      else resolve(Number(meta?.format?.duration) || 0);
    });
  });
};

// Concat using demuxer
const concatWithDemuxer = async (listPath, output) => {
  const cmd = `ffmpeg -y -f concat -safe 0 -i "${listPath}" -c copy "${output}"`;
  await execAsync(cmd);
  return output;
};

// Language code mappings
const getLanguageCode = (language) => {
  const map = {
    'spanish': 'es','french': 'fr','german': 'de','italian': 'it','portuguese': 'pt',
    'hindi': 'hi','tamil': 'ta','english': 'en',
    'bengali': 'bn','telugu': 'te','marathi': 'mr','gujarati': 'gu',
    'kannada': 'kn','malayalam': 'ml','punjabi': 'pa','urdu': 'ur'
  };
  return map[language.toLowerCase()] || 'en';
};

// gTTS supported languages (fallback)
const gTTSSupportedLanguages = ['es', 'fr', 'de', 'it', 'pt', 'hi', 'ta', 'en'];

// Generate TTS with Soniox (primary) → ElevenLabs → gTTS (fallback)
const generateAudioWithTTS = async (text, language, outPath) => {
  const langCode = getLanguageCode(language);

  // Try Soniox first if available
  if (sonioxAvailable) {
    try {
      console.log(`🔊 Using Soniox for ${language} (${langCode})`);

      const response = await axios.post(
        'https://tts-rt.soniox.com/tts',
        {
          text: text,
          model: 'tts-rt-v1', // Soniox's multilingual TTS model
          language: langCode,
          voice: 'maya', // Default multilingual voice
          audio_format: 'wav' // Get WAV format directly
        },
        {
          headers: {
            'Authorization': `Bearer ${SONIOX_API_KEY}`,
            'Content-Type': 'application/json'
          },
          responseType: 'arraybuffer'
        }
      );

      fsSync.writeFileSync(outPath, Buffer.from(response.data));
      console.log(`✅ Soniox TTS successful: ${outPath}`);
      return outPath;

    } catch (err) {
      console.log(`⚠️ Soniox failed:`);
      console.log(`   Status: ${err.response?.status || 'unknown'}`);
      console.log(`   Message: ${err.message}`);
      console.log(`   Falling back to ElevenLabs/gTTS...`);
      // Fall through to next option
    }
  }

  // Try ElevenLabs second if available
  if (elevenLabsAvailable && elevenLabsClient) {
    try {
      console.log(`🔊 Using ElevenLabs for ${language} (${langCode})`);

      const audioStream = await elevenLabsClient.generate({
        voice: "21m00Tcm4TlvDq8ikWAM", // Rachel - Multilingual voice
        model_id: "eleven_multilingual_v2",
        text: text,
        language_code: langCode
      });

      // Convert stream to buffer and save
      const chunks = [];
      for await (const chunk of audioStream) {
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);
      fsSync.writeFileSync(outPath, buffer);

      console.log(`✅ ElevenLabs TTS successful: ${outPath}`);
      return outPath;

    } catch (err) {
      console.log(`⚠️ ElevenLabs failed:`);
      console.log(`   Status: ${err.statusCode || 'unknown'}`);
      console.log(`   Message: ${err.message}`);
      console.log(`   Body: ${JSON.stringify(err.body || {})}`);
      console.log(`   Falling back to gTTS...`);
      // Fall through to gTTS
    }
  }

  // Fallback to gTTS
  return new Promise((resolve, reject) => {
    // Check if gTTS supports this language
    if (!gTTSSupportedLanguages.includes(langCode)) {
      return reject(new Error(
        `Language "${language}" (${langCode}) not supported. ` +
        `Set SONIOX_API_KEY or ELEVENLABS_API_KEY for all Indian languages.`
      ));
    }

    console.log(`🔊 Using gTTS fallback for ${language} (${langCode})`);
    const tts = new gTTS(text, langCode);
    tts.save(outPath, (err) => {
      if (err) reject(err);
      else {
        console.log(`✅ gTTS successful: ${outPath}`);
        resolve(outPath);
      }
    });
  });
};

// Download video - WINDOWS OPTIMIZED with multiple fallback methods
const downloadVideoOnly = async (videoId, outputPath) => {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  
  console.log('🎬 Attempting video download...');
  
  // Methods optimized for Windows - tries 5 different approaches
  const methods = [
    {
      name: 'Android Client',
      cmd: `yt-dlp --extractor-args "youtube:player_client=android" -f "bestvideo[ext=mp4][height<=1080]" --no-audio -o "${outputPath}" "${url}"`
    },
    {
      name: 'iOS Client',
      cmd: `yt-dlp --extractor-args "youtube:player_client=ios" -f "bestvideo[ext=mp4]" --no-audio -o "${outputPath}" "${url}"`
    },
    {
      name: 'Chrome Cookies',
      cmd: `yt-dlp --cookies-from-browser chrome -f "bestvideo[ext=mp4]" --no-audio -o "${outputPath}" "${url}"`
    },
    {
      name: 'Standard',
      cmd: `yt-dlp -f "bestvideo[ext=mp4][height<=720]" --no-audio -o "${outputPath}" "${url}"`
    },
    {
      name: 'Low Quality',
      cmd: `yt-dlp --extractor-args "youtube:player_client=android" -f "worst[ext=mp4]" --no-audio -o "${outputPath}" "${url}"`
    },
  ];

  let lastError;
  
  for (let i = 0; i < methods.length; i++) {
    try {
      console.log(`⚡ Trying ${methods[i].name} (${i + 1}/${methods.length})...`);
      
      const { stdout, stderr } = await execAsync(methods[i].cmd, {
        timeout: 120000,
        windowsHide: true
      });
      
      if (fsSync.existsSync(outputPath)) {
        const stats = fsSync.statSync(outputPath);
        if (stats.size > 1000) {
          console.log(`✅ Success with ${methods[i].name}! Size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
          return outputPath;
        }
      }
    } catch (error) {
      lastError = error;
      console.log(`❌ ${methods[i].name} failed`);
      
      if (error.stderr) {
        const errorLines = error.stderr.split('\n').filter(line => 
          line.includes('ERROR') || line.includes('403')
        ).slice(0, 2);
        errorLines.forEach(line => console.log(`   ${line.substring(0, 100)}`));
      }
      
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  
  throw new Error(`All methods failed. Update yt-dlp: python -m pip install -U yt-dlp. Last error: ${lastError?.message?.substring(0, 200) || 'Unknown'}`);
};

// Merge video + audio
const mergeVideoAudio = async (videoPath, audioPath, outPath) => {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(videoPath)
      .input(audioPath)
      .videoCodec('copy')
      .audioCodec('aac')
      .outputOptions(['-map', '0:v:0', '-map', '1:a:0'])
      .on('end', () => resolve(outPath))
      .on('error', reject)
      .save(outPath);
  });
};

// --------------------------------------------------------
// CHECK TRANSCRIPT API
// --------------------------------------------------------
app.post('/api/check-transcript', async (req, res) => {
  try {
    const videoId = extractVideoId(req.body.videoUrl);
    if (!videoId) return res.status(400).json({ error: 'Invalid URL' });

    const result = await validateTranscriptAvailability(videoId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --------------------------------------------------------
// MAIN DUBBING API (FIXED TIMELINE VERSION)
// --------------------------------------------------------
app.post('/api/dub-video', async (req, res) => {
  const { videoUrl, targetLanguage } = req.body;
  const jobId = uuidv4();

  console.log(`\n🎯 NEW DUBBING JOB`);
  console.log(`   Video: ${videoUrl}`);
  console.log(`   Target Language: ${targetLanguage}`);
  console.log(`   Translator Available: ${translatorAvailable}`);

  try {
    await ensureDownloadsDir();
    const jobDir = path.join(__dirname, 'downloads', jobId);
    await fs.mkdir(jobDir, { recursive: true });

    const videoId = extractVideoId(videoUrl);
    if (!videoId) return res.status(400).json({ error: 'Invalid URL' });

    // Fetch transcript
    let transcript = await fetchTranscript(videoId);
    console.log(`Fetched transcript: ${transcript.length} segments`);

    // Show sample of original transcript
    if (transcript.length > 0) {
      console.log(`   Sample original text: "${transcript[0].text.substring(0, 50)}..."`);
    }

    // CLEAN duplicates
    transcript = cleanTranscriptArray(transcript);
    console.log(`Cleaned transcript: ${transcript.length}`);

    // Translate
    console.log(`\n🌐 Starting translation to: ${targetLanguage}`);
    const translated = await batchTranslateText(transcript, targetLanguage);

    // Count translation errors
    let translationErrors = 0;
    translated.forEach(item => {
      if (item.translatedText === item.text) translationErrors++;
    });

    // Show sample of translated text
    if (translated.length > 0) {
      console.log(`   Sample translated text: "${translated[0].translatedText.substring(0, 50)}..."`);
    }
    console.log(`   Translation errors: ${translationErrors}/${translated.length} segments unchanged`);

    // TTS + 1.6× processing
    const normalizedClips = [];

    for (let i = 0; i < translated.length; i++) {
      const item = translated[i];
      if (!item.translatedText?.trim()) continue;

      const rawMp3 = path.join(jobDir, `raw_${i}.mp3`);
      const normWav = path.join(jobDir, `norm_${i}.wav`);
      const speed2x = path.join(jobDir, `clip_2x_${i}.wav`);

      // Generate TTS
      await generateAudioWithTTS(item.translatedText, targetLanguage, rawMp3);

      // Normalize
      try {
        await normalizeAudioToStandardWav(rawMp3, normWav);
      } catch {
        await execAsync(`ffmpeg -y -i "${rawMp3}" -ac 1 -ar 22050 -c:a pcm_s16le "${normWav}"`);
      }

      // Remove raw
      try { await fs.unlink(rawMp3); } catch {}

      // Apply 1.6x speed
      await apply2xSpeed(normWav, speed2x);

      // Remove original normalized file
      try { await fs.unlink(normWav); } catch {}

      // Use subtitle timing directly
      normalizedClips.push({
        path: speed2x,
        start: item.start,
        originalDuration: item.duration,
        index: i
      });
    }

    // Sort by subtitle timing
    normalizedClips.sort((a, b) => a.start - b.start);

    // --------------------------------------------------------
    // BUILD AUDIO TIMELINE (FIXED VERSION)
    // --------------------------------------------------------
    const ordered = [];
    let cursor = 0;

    // IMPORTANT: Add initial silence if first clip doesn't start at 0
    if (normalizedClips.length > 0 && normalizedClips[0].start > 0.05) {
      const initialSilence = path.join(jobDir, 'initial_silence.wav');
      await createSilence(normalizedClips[0].start, initialSilence);
      ordered.push(initialSilence);
      cursor = normalizedClips[0].start;
      console.log(`✓ Added initial silence: ${normalizedClips[0].start}s`);
    }

    for (let clip of normalizedClips) {
      // Add gap silence if needed between clips
      if (clip.start > cursor + 0.05) {
        const gap = clip.start - cursor;
        const silencePath = path.join(jobDir, `gap_${clip.index}.wav`);
        await createSilence(gap, silencePath);
        ordered.push(silencePath);
        cursor += gap;
        console.log(`✓ Added gap silence: ${gap.toFixed(2)}s at position ${cursor.toFixed(2)}s`);
      }

      // Add the audio clip
      ordered.push(clip.path);
      
      // Get actual duration of the sped-up audio
      const actualDuration = await getAudioDuration(clip.path);
      
      // Move cursor to the END of this clip based on actual audio duration
      cursor += actualDuration;
      
      console.log(`✓ Added clip ${clip.index}: starts at ${clip.start.toFixed(2)}s, duration ${actualDuration.toFixed(2)}s, cursor now at ${cursor.toFixed(2)}s`);
    }

    // Add final padding
    const pad = path.join(jobDir, 'pad.wav');
    await createSilence(0.05, pad);
    ordered.push(pad);

    console.log(`\n📊 Total audio clips: ${ordered.length}, Final duration: ${cursor.toFixed(2)}s\n`);

    // Create concat list
    const listFile = path.join(jobDir, 'concat.txt');
    await fs.writeFile(
      listFile,
      ordered.map(p => `file '${p}'`).join('\n')
    );

    const finalAudio = path.join(jobDir, 'final_audio.wav');
    await concatWithDemuxer(listFile, finalAudio);

    // Download video
    const videoPath = path.join(jobDir, 'video.mp4');
    await downloadVideoOnly(videoId, videoPath);

    // Merge
    const finalVideo = path.join(jobDir, 'dubbed_video.mp4');
    await mergeVideoAudio(videoPath, finalAudio, finalVideo);

    res.json({
      success: true,
      jobId,
      downloadUrl: `/downloads/${jobId}/dubbed_video.mp4`,
      message: 'Video dubbed successfully!',
      transcriptSegments: transcript.length,
      translationErrors: translationErrors
    });

  } catch (err) {
    console.error('Dubbing failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// --------------------------------------------------------
// HEALTH CHECK
// --------------------------------------------------------
app.get('/api/health', (req, res) => {
  res.json({
    status: 'OK',
    translator: translatorAvailable ? 'Connected' : 'Not Connected'
  });
});

// Test translation on startup
const testTranslation = async () => {
  if (!translatorAvailable) {
    console.log('\n⚠️  WARNING: Translation API not configured.');
    console.log('   Set RAPIDAPI_KEY in .env file to enable translation.');
    console.log('   Videos will be dubbed in the ORIGINAL language (English).\n');
    return;
  }

  console.log('\n🧪 Testing translation API...');
  try {
    const testResult = await translateText("Hello world", "spanish");
    if (testResult === "Hello world") {
      console.log('❌ Translation test FAILED - API returned original text\n');
    } else {
      console.log(`✅ Translation test PASSED: "Hello world" → "${testResult}"\n`);
    }
  } catch (err) {
    console.log(`❌ Translation test ERROR: ${err.message}\n`);
  }
};

// Test Soniox on startup
const testSoniox = async () => {
  if (!sonioxAvailable) {
    console.log('\n🔊 Soniox: Not configured');
    return;
  }

  console.log('\n🧪 Testing Soniox API...');
  try {
    const response = await axios.post(
      'https://tts-rt.soniox.com/tts',
      {
        text: 'Hello',
        model: 'tts-rt-v1',
        language: 'en',
        voice: 'maya',
        audio_format: 'wav'
      },
      {
        headers: {
          'Authorization': `Bearer ${SONIOX_API_KEY}`,
          'Content-Type': 'application/json'
        },
        responseType: 'arraybuffer'
      }
    );

    if (response.data && response.data.length > 0) {
      console.log(`✅ Soniox TTS test PASSED - API key valid`);
      console.log(`   Audio size: ${response.data.length} bytes\n`);
    }
  } catch (err) {
    console.log(`❌ Soniox test FAILED:`);
    console.log(`   Status: ${err.response?.status || 'N/A'}`);
    console.log(`   Message: ${err.message}`);

    if (err.response?.status === 401) {
      console.log(`\n⚠️  INVALID API KEY - Check your SONIOX_API_KEY`);
    } else if (err.response?.status === 429) {
      console.log(`\n⚠️  RATE LIMITED - Too many requests`);
    } else {
      console.log(`\n⚠️  API Error - Check https://soniox.com status`);
    }
    console.log('');
  }
};

// Test ElevenLabs on startup
const testElevenLabs = async () => {
  if (!elevenLabsAvailable || !elevenLabsClient) {
    console.log('\n🔊 ElevenLabs: Not configured');
    return;
  }

  console.log('\n🧪 Testing ElevenLabs API...');
  try {
    // Try a simple test request
    const voices = await elevenLabsClient.voices.getAll();
    console.log(`✅ ElevenLabs API connection OK`);
    console.log(`   Available voices: ${voices.voices?.length || 0}`);

    // Try to generate a short test audio
    const testAudio = await elevenLabsClient.generate({
      voice: "21m00Tcm4TlvDq8ikWAM",
      model_id: "eleven_multilingual_v2",
      text: "Hello"
    });

    // Just consume the stream to verify it works
    for await (const chunk of testAudio) {
      // Discard chunks, just testing connection
      break;
    }

    console.log(`✅ ElevenLabs TTS test PASSED - Account has credits\n`);
  } catch (err) {
    console.log(`❌ ElevenLabs test FAILED:`);
    console.log(`   Status: ${err.statusCode || 'N/A'}`);
    console.log(`   Message: ${err.message}`);

    if (err.statusCode === 401) {
      console.log(`\n⚠️  INVALID API KEY - Check your ELEVENLABS_API_KEY`);
    } else if (err.statusCode === 402) {
      console.log(`\n⚠️  OUT OF CREDITS - Your free tier is exhausted`);
      console.log(`   Options: 1) Upgrade at elevenlabs.io`);
      console.log(`            2) Create new account with different email`);
      console.log(`            3) Use only Hindi/Tamil with gTTS fallback\n`);
    } else {
      console.log(`\n⚠️  API Error - Check your internet connection\n`);
    }
  }
};

app.listen(PORT, async () => {
  console.log(`🚀 DubFlow API running @ http://localhost:${PORT}`);
  await testTranslation();
  await testSoniox();
  await testElevenLabs();
});
