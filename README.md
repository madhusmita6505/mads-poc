# MADS - Meeting AI Decision Support

Real-time AI suggestion engine for financial advisors during live client calls (e.g., Zoom).

Captures **both sides** of the conversation — your mic (Advisor) and system speaker output (Client via Zoom) — transcribes in real-time via **OpenAI Realtime Transcription API**, and generates ultra-short actionable suggestions via **OpenAI GPT-4o-mini**. All streamed to a live dashboard. **No third-party audio software needed.**

## Architecture

```
Browser captures TWO audio streams simultaneously:

  Microphone (Advisor's voice)  ──┐
                                  ├──► WebSocket ──► FastAPI Server
  System Audio (Client's voice) ──┘        │                │
    via Chrome getDisplayMedia             │     ┌──────────┴──────────┐
                                           │     │ OpenAI Realtime (mic)    │ ← transcription
                                           │     │ OpenAI Realtime (speaker)│ ← transcription
                                           │     └──────────┬──────────┘
                                           │                │
                                           │     OpenAI GPT-4o-mini
                                           │     (ultra-short suggestions)
                                           │                │
                                           ◄────────────────┘
                                     Streamed back to UI
```

## Prerequisites

- **Python 3.10+**
- **Google Chrome** (required for system audio capture)
- **OpenAI API Key** — [Get one here](https://platform.openai.com/api-keys)
- No third-party audio software (BlackHole, VoiceMeeter, etc.) needed

## Setup

1. **Enter the project:**

   ```bash
   cd madsPOC
   ```

2. **Create a virtual environment and install dependencies:**

   ```bash
   python3 -m venv venv
   source venv/bin/activate        # macOS/Linux
   # venv\Scripts\activate          # Windows
   pip install -r requirements.txt
   ```

3. **Configure API key:**

   ```bash
   cp .env.example .env
   ```

   Edit `.env` and add your OpenAI API key:

   ```
   OPENAI_API_KEY=your_key_here
   ```

4. **Run the server:**

   ```bash
   python server.py
   ```

5. **Open the dashboard:**

   Navigate to [http://localhost:8001](http://localhost:8001) in **Chrome**.

## Usage — During a Zoom Call

1. **Start your Zoom call** as usual. **Use headphones** for best speaker separation.
2. **Open the MADS dashboard** at `http://localhost:8001` in Chrome alongside Zoom.
3. **Select your microphone** from the dropdown in the bottom controls bar.
4. **Leave "Capture client audio" checked** (enabled by default).
5. **Click "Start Listening".**
6. Chrome will show a **screen-share dialog**:
   - Select **"Entire Screen"** (any screen if multiple monitors)
   - **Check "Share audio"** (critical — this is how we capture the client's Zoom voice)
   - Click **Share**
7. Both Mic and Speaker indicators in the header will turn **green**.
8. The **live transcript** shows speaker-labeled lines (Advisor in purple, Client in green).
9. **AI suggestions** appear on the right — ultra-short (max 10 words) so you can read them at a glance.

> **Note:** The screen share is only used for audio capture. The video track is kept alive but unused — no screen content is recorded or transmitted.

> **Tip:** Use headphones to prevent your microphone from picking up the client's voice from your speakers. This dramatically improves speaker separation accuracy.

## Platform Notes

### macOS
- Requires **macOS 13 (Ventura) or later** + **Chrome 107+** for system audio capture via `getDisplayMedia`.
- When the share dialog appears, select your screen and audio should be captured automatically.

### Windows
- Chrome on Windows has excellent system audio capture support.
- When the share dialog appears, select **"Entire Screen"** and check **"Share system audio"**.
- Works on Windows 10 and later.

### Fallback: Mic Only
- If system audio capture fails (user cancels dialog, unsupported browser), the app gracefully continues with **mic only** (Advisor's voice).
- The AI still generates suggestions based on what the Advisor says.

## How It Works

1. **Dual Audio Capture**: The browser captures two separate audio streams via Web Audio API (AudioWorklet):
   - `getUserMedia` → Microphone (Advisor's voice) with echo cancellation enabled
   - `getDisplayMedia` → System audio (Client's voice via Zoom speakers)
   Each stream is encoded as linear16 PCM at 24kHz and tagged with a source byte.

2. **Speaker-Separated Transcription**: The server routes each audio stream to a separate OpenAI Realtime Transcription connection (`gpt-4o-mini-transcribe`). Audio is base64-encoded and sent as JSON. Transcripts are labeled "Advisor" or "Client". Built-in noise reduction and VAD provide clean utterance boundaries.

3. **Ultra-Short AI Suggestions**: The labeled conversation transcript provides context:
   ```
   Advisor: Tell me about your financial goals.
   Client: We want to save for our daughter's college education. She's 14.
   ```
   This is sent to OpenAI GPT-4o-mini which generates a single suggestion of **max 10 words**, e.g.:
   > **Suggest** 529 Plan for education savings

4. **Low-Latency Pipeline**:
   - AudioWorklet → server: ~100ms chunks
   - OpenAI transcription: ~500ms latency
   - OpenAI suggestion first token: ~500ms
   - **Total: suggestions begin appearing within ~1.5 seconds of speech**

## Configuration

Key parameters in `server.py`:

| Parameter | Default | Description |
|---|---|---|
| `SUGGESTION_COOLDOWN_SECONDS` | 6 | Minimum seconds between suggestion generations |
| `MIN_NEW_CHARS_FOR_SUGGESTION` | 60 | Minimum new transcript characters before triggering |
| `OPENAI_MODEL` | `gpt-4o-mini` | Model for suggestion generation |
| `TRANSCRIPTION_MODEL` | `gpt-4o-mini-transcribe` | Model for real-time transcription |

## Tech Stack

- **Backend**: Python, FastAPI, WebSockets
- **Transcription**: OpenAI Realtime API (`gpt-4o-mini-transcribe`, real-time streaming, separate per speaker)
- **AI Suggestions**: OpenAI GPT-4o-mini (streaming, max 10 words)
- **Frontend**: Vanilla HTML/CSS/JS, Web Audio API (AudioWorklet)
- **Audio Capture**: Chrome `getUserMedia` (mic) + `getDisplayMedia` (system audio)

---------------------

TRANSCRIPTION_MODE=rest
MS_TRANSCRIPTION_URL=https://aigateway-webfarm-dev.ms.com/openai/v1/audio/transcriptions
MS_ASSERT_USERNAME=your_username_here
