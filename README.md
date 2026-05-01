# DubFlow

AI-powered YouTube video dubbing application that translates and dubs videos into 25+ languages with synchronized audio.

![DubFlow Screenshot](https://via.placeholder.com/800x400/4c1d95/ffffff?text=DubFlow+-+AI+Video+Dubbing)

## Features

- **25+ Languages Supported** - Including Hindi, Tamil, Bengali, Telugu, Spanish, French, German, Japanese, and more
- **Multi-Tier TTS System** - Cascading fallback: Soniox → ElevenLabs → gTTS for maximum reliability
- **Timing Synchronization** - Dubbed audio aligns with original speech timing using intelligent silence insertion
- **Smart Transcript Cleaning** - LLM-powered removal of duplicates and filler words while preserving timestamps
- **Speed Optimization** - Audio processed at 1.6x speed to match natural speech pacing
- **Modern UI** - Responsive React frontend with TailwindCSS animations

## Tech Stack

### Frontend
- **Next.js 14** - React framework with App Router
- **TypeScript** - Type-safe development
- **TailwindCSS** - Utility-first styling
- **Lucide React** - Icon library

### Backend
- **Node.js + Express** - REST API server
- **FFmpeg** - Audio/video processing
- **yt-dlp** - YouTube video downloading

### External APIs
- **RapidAPI Google Translator** - Text translation
- **Soniox TTS** - Primary text-to-speech (multilingual)
- **ElevenLabs** - Secondary TTS (multilingual voices)
- **OpenRouter** - LLM transcript cleaning (Llama 3)
- **gTTS** - Fallback TTS (free, limited languages)

## Prerequisites

- Node.js 18+ and npm
- FFmpeg installed on system
- yt-dlp installed on system
- API keys for external services (see Environment Variables)

### Installing FFmpeg

**macOS:**
```bash
brew install ffmpeg
```

**Ubuntu/Debian:**
```bash
sudo apt update
sudo apt install ffmpeg
```

**Windows:**
Download from https://ffmpeg.org/download.html and add to PATH

### Installing yt-dlp

```bash
pip install yt-dlp
```

## Installation

1. Clone the repository
```bash
git clone https://github.com/kanak-ag/DubFlow_web.git
cd DubFlow_web
```

2. Install backend dependencies
```bash
cd Backend
npm install
```

3. Install frontend dependencies
```bash
cd ../Frontend
npm install
```

4. Create environment files
```bash
# Backend/.env
cp Backend/.env.example Backend/.env
# Edit Backend/.env with your API keys
```

## Environment Variables

Create `Backend/.env` with the following:

```env
# Required for translation
RAPIDAPI_KEY=your_rapidapi_key_here

# At least one TTS provider required
SONIOX_API_KEY=your_soniox_key_here          # Recommended for Indian languages
ELEVENLABS_API_KEY=your_elevenlabs_key_here  # Alternative premium TTS

# Optional - for LLM transcript cleaning
OPENROUTER_API_KEY=your_openrouter_key_here

# Server configuration
PORT=3001
```

### Getting API Keys

- **RapidAPI**: https://rapidapi.com/googlecloud/api/google-translator9
- **Soniox**: https://soniox.com (free tier available)
- **ElevenLabs**: https://elevenlabs.io (free tier available)
- **OpenRouter**: https://openrouter.ai (optional, for transcript cleaning)

## Usage

1. Start the backend server
```bash
cd Backend
node server.js
```

Server will start on http://localhost:3001 and run startup tests for all configured APIs.

2. Start the frontend development server
```bash
cd Frontend
npm run dev
```

3. Open http://localhost:3000 in your browser

4. Enter a YouTube URL, select target language, and click "Start Dubbing"

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/dub-video` | Process video dubbing |
| POST | `/api/check-transcript` | Check transcript availability |
| GET | `/api/health` | Health check & service status |
| GET | `/downloads/{jobId}/dubbed_video.mp4` | Download completed video |

### Example API Request

```bash
curl -X POST http://localhost:3001/api/dub-video \
  -H "Content-Type: application/json" \
  -d '{
    "videoUrl": "https://www.youtube.com/watch?v=VIDEO_ID",
    "targetLanguage": "hindi"
  }'
```

## Project Structure

```
DubFlow_web/
├── Backend/
│   ├── server.js              # Main Express server
│   ├── transcript-fetcher.js  # YouTube transcript extraction
│   ├── downloads/             # Generated videos storage
│   └── .env                   # API keys (not in git)
├── Frontend/
│   ├── app/
│   │   └── page.tsx           # Main page
│   ├── components/
│   │   └── YouTubeDubber.js   # Main UI component
│   └── package.json
└── README.md
```

## How It Works

1. **Transcript Extraction**: Fetches YouTube captions via `youtube-transcript` library, with yt-dlp fallback
2. **Cleaning**: LLM removes filler words and duplicates while preserving timing
3. **Translation**: Each segment translated via RapidAPI Google Translator
4. **TTS Generation**: Cascading TTS providers generate audio for translated text
5. **Audio Processing**: Speech normalized and sped up 1.6x for natural pacing
6. **Timeline Sync**: Audio clips arranged with calculated silences to match original timing
7. **Video Merge**: FFmpeg combines dubbed audio with downloaded video

## Supported Languages

| Language | Code | TTS Support |
|----------|------|-------------|
| Spanish | `spanish` | All providers |
| French | `french` | All providers |
| German | `german` | All providers |
| Hindi | `hindi` | Soniox, ElevenLabs, gTTS |
| Tamil | `tamil` | Soniox, ElevenLabs, gTTS |
| Bengali | `bengali` | Soniox, ElevenLabs |
| Telugu | `telugu` | Soniox, ElevenLabs |
| Marathi | `marathi` | Soniox, ElevenLabs |
| Gujarati | `gujarati` | Soniox, ElevenLabs |
| Kannada | `kannada` | Soniox, ElevenLabs |
| Malayalam | `malayalam` | Soniox, ElevenLabs |
| Punjabi | `punjabi` | Soniox, ElevenLabs |
| Urdu | `urdu` | Soniox, ElevenLabs |
| Japanese | `japanese` | Soniox, ElevenLabs |
| Korean | `korean` | Soniox, ElevenLabs |
| Chinese | `chinese` | Soniox, ElevenLabs |
| Arabic | `arabic` | Soniox, ElevenLabs |
| Russian | `russian` | Soniox, ElevenLabs |
| Italian | `italian` | All providers |
| Portuguese | `portuguese` | All providers |
| Dutch | `dutch` | Soniox, ElevenLabs |
| Polish | `polish` | Soniox, ElevenLabs |
| Turkish | `turkish` | Soniox, ElevenLabs |
| Thai | `thai` | Soniox, ElevenLabs |
| Vietnamese | `vietnamese` | Soniox, ElevenLabs |

## Troubleshooting

### "All methods failed" error when downloading video
- Update yt-dlp: `pip install -U yt-dlp`
- Some videos may be restricted or require authentication

### Translation not working
- Verify `RAPIDAPI_KEY` is set correctly
- Check RapidAPI subscription status

### TTS fails for specific language
- Indian languages require Soniox or ElevenLabs (gTTS doesn't support them)
- Check API key validity and credit balance
- Fallback system will automatically try next provider

### Audio timing is off
- The system applies 1.6x speedup to match natural speech
- Some languages may need manual adjustment in `apply2xSpeed()` function

### CORS errors
- Ensure backend is running on port 3001
- Check that `cors` middleware is enabled in `server.js`

## License

MIT License - feel free to use for personal or commercial projects.

## Contributing

Pull requests welcome! Please ensure:
- Code follows existing style
- Test your changes with multiple languages
- Update documentation as needed

## Credits

Built with love for content creators who want to reach global audiences.

---

**Note**: Respect YouTube's Terms of Service and copyright laws when using this tool. Only process videos you have rights to dub.
