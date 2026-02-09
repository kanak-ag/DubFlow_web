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
    'hindi': 'hi','japanese': 'ja','korean': 'ko','chinese': 'zh-CN','english': 'en'
  };
  return map[language.toLowerCase()] || language.toLowerCase();
};

// Translate text
const translateText = async (text, targetLanguage) => {
  try {
    if (!translatorAvailable) return text;

    const targetLangCode = getRapidApiLanguageCode(targetLanguage);
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

    return response.data?.data?.translations?.[0]?.translatedText || text;
  } catch (err) {
    console.warn('Translation failed:', err.message);
    return text;
  }
};

// Batch translate
const batchTranslateText = async (arr, targetLanguage) => {
  const result = [];
  for (let item of arr) {
    const translated = await translateText(item.text, targetLanguage);
    result.push({ ...item, translatedText: translated });
    await new Promise(r => setTimeout(r, 150));
  }
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

// Generate TTS
const generateAudioWithGTTS = async (text, language, outPath) => {
  return new Promise((resolve, reject) => {
    const langMap = {
      'spanish': 'es','french': 'fr','german': 'de','hindi': 'hi','english': 'en'
    };
    const lang = langMap[language.toLowerCase()] || 'en';

    const tts = new gTTS(text, lang);
    tts.save(outPath, (err) => err ? reject(err) : resolve(outPath));
  });
};

// Download video
const downloadVideoOnly = async (videoId, outputPath) => {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const command = `yt-dlp -f "bestvideo[ext=mp4]" --no-audio -o "${outputPath}" "${url}"`;
  await execAsync(command);
  return outputPath;
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

  try {
    await ensureDownloadsDir();
    const jobDir = path.join(__dirname, 'downloads', jobId);
    await fs.mkdir(jobDir, { recursive: true });

    const videoId = extractVideoId(videoUrl);
    if (!videoId) return res.status(400).json({ error: 'Invalid URL' });

    // Fetch transcript
    let transcript = await fetchTranscript(videoId);
    console.log(`Fetched transcript: ${transcript.length}`);

    // CLEAN duplicates
    transcript = cleanTranscriptArray(transcript);
    console.log(`Cleaned transcript: ${transcript.length}`);

    // Translate
    const translated = await batchTranslateText(transcript, targetLanguage);

    // TTS + 1.6× processing
    const normalizedClips = [];

    for (let i = 0; i < translated.length; i++) {
      const item = translated[i];
      if (!item.translatedText?.trim()) continue;

      const rawMp3 = path.join(jobDir, `raw_${i}.mp3`);
      const normWav = path.join(jobDir, `norm_${i}.wav`);
      const speed2x = path.join(jobDir, `clip_2x_${i}.wav`);

      // Generate TTS
      await generateAudioWithGTTS(item.translatedText, targetLanguage, rawMp3);

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
      downloadUrl: `/downloads/${jobId}/dubbed_video.mp4`
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

app.listen(PORT, () => {
  console.log(`🚀 DubFlow API running @ http://localhost:${PORT}`);
});