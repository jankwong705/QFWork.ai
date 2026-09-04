<div align="center">
  <img src="public/logo.png" alt="QFwork" width="120" />
  <h1>QFwork.ai</h1>
  <p><strong>AI Trainer for workplace communication</strong></p>
</div>

---

QFwork.ai is a web application for practising spoken workplace English. A user holds a live, face-to-face video conversation with an AI partner across four professional scenarios, then receives a structured coaching report covering **what they said**, **how they sounded**, and **how they presented on camera**.

It is built for professionals in Hong Kong and the Greater Bay Area, and every service it depends on is accessible from that region.

## Why it exists

Conventional language tools assess reading and writing. Workplace English, however, tends to fail in situations that are spoken, unscripted and high-pressure — negotiating an offer, presenting to a director, meeting a client for the first time. Those situations cannot be rehearsed alone, and professional coaching is expensive, difficult to schedule and inconsistent between sessions.

QFwork.ai provides unlimited, repeatable practice of exactly those conversations, and returns something a human coach cannot produce consistently: **measured evidence** of how the speaker actually performed, derived from their voice and their conversation rather than from impression alone.

## Feedback model

The report is assembled from three independent signals captured during a single session.

| Signal | Source | Produces |
| --- | --- | --- |
| **Language** | Conversation transcript | Structure, evidence, strategy and professional register, graded against a scenario-specific rubric |
| **Voice** | Recorded microphone audio | Intonation, speaking rate, hesitation pauses, vocal energy, articulation clarity |
| **Presence** | Camera, during the session | Eye contact, facial expression, posture, composure, engagement |

Voice metrics are measured from the waveform and from word-level speech timings, not inferred from text. The language model that writes the report receives these figures as data and is constrained from asserting acoustic detail that was not measured; if audio is unavailable, the report states so rather than estimating.

## Practice scenarios

| Scenario | Focus |
| --- | --- |
| Job Interview | Background, strengths and role fit, adapted to the user's target position |
| Salary Negotiation | Anchoring, value-based justification and collaborative tone against a manager who pushes back |
| Business Presentation | An uninterrupted delivery to a senior executive, followed by a probing Q&A |
| Client Meeting | Rapport, value proposition and mutual-benefit framing in a first meeting |

Each scenario carries its own grading rubric, so a fluent but strategically weak negotiation scores lower than fluency alone would suggest. Business Presentation additionally runs on a dedicated AI persona configured for patient turn-taking, allowing the user to hold the floor and pause to think without being interrupted.

## Technology

### Stack

| Layer | Technology |
| --- | --- |
| Runtime | Node.js 18+ |
| Server | Express |
| Frontend | HTML, CSS and JavaScript with no framework or build step |
| Audio capture | Web Audio API (`AudioWorklet`) |
| Signal processing | Custom JavaScript DSP, no external dependencies |
| Conversational video | Tavus Conversational Video Interface |
| Language model | Groq — Llama 3.3 70B |
| Speech-to-text | Groq — Whisper Large v3 Turbo |
| Hosting | Any platform that runs a persistent Node process |

The dependency list is deliberately small: `express`, `cors`, `dotenv` and `node-fetch`. Pitch tracking and loudness analysis are implemented directly rather than pulled from a library, which keeps the install lightweight and avoids native build steps at deploy time.

### Conversational video configuration

The AI partner is composed of several Tavus models, each selected explicitly and provisioned from `setup-tavus.js` so that the entire configuration is reproducible from source control.

| Component | Model | Responsibility |
| --- | --- | --- |
| Video rendering | Phoenix-4 | Photoreal face, lip-sync and expression |
| Conversation | Gemini 2.5 Flash (Tavus-hosted) | Dialogue generation, selected for low latency |
| Perception | Raven-1 | Camera observation and end-of-session presence analysis |
| Turn detection | Sparrow-1 | Detecting when the user has finished speaking |
| Speech synthesis | Cartesia Sonic-3 | Voice output with emotional inflection |

Speculative inference is enabled, allowing the language model to begin generating before the user stops speaking. This is the single largest contributor to perceived responsiveness.

## Architecture

```
Browser                          Server                        External services
───────                          ──────                        ─────────────────
scenario selection ────────────► POST /api/conversation ─────► Tavus: create session
                                                          ◄─── session URL
video session ◄──────────────────────────────────────────────► Tavus (WebRTC)
microphone capture
  (AudioWorklet → WAV)

session ends ──────────────────► POST /api/voice-sample/:id
                                   (held in memory only)
               ────────────────► POST /api/interview-feedback
                                   ├── Tavus: transcript + presence analysis
                                   ├── Groq Whisper: word-level timings
                                   ├── local DSP: pitch and loudness
                                   └── Groq LLM: report generation
report ◄─────────────────────────  structured JSON
```

The microphone is recorded by the page in parallel with the video session, because the conversational video service does not expose raw participant audio. Recording locally is what makes the voice analysis possible.

Transcript and presence analysis are finalised asynchronously by Tavus after a session ends, so the server polls for them within a bounded window. The voice analysis runs concurrently with that polling and therefore adds no additional waiting time.

### Design decisions

- **Credentials never reach the client.** The browser receives only a session URL. All API keys are read from the environment on the server.
- **Audio is not persisted.** Recordings are held in server memory for the duration of the analysis and then discarded. Nothing is written to disk or to third-party storage.
- **Every feedback layer is optional.** A failure in voice analysis or camera perception yields a smaller report rather than a failed request.
- **Configuration is verified at startup.** The server checks that each persona carries its perception layer and repairs it if absent, since a missing layer otherwise fails silently.
- **Session cost is bounded.** A hard per-session duration cap, plus automatic termination when a user abandons a session, prevents unbounded billing.
- **The trial is gated, on the server.** Access codes are checked and trial runs are counted server-side, so the browser gate is a front door rather than the lock. See [Access and trial limits](#access-and-trial-limits).

## Access and trial limits

The site is public; the product is not. Every live session spends conversational-video minutes and language-model tokens, so a visitor must enter an access code before reaching the application.

Two codes are configured, and they define two tiers:

| Tier | Variable | Report | Sessions |
| --- | --- | --- | --- |
| Demo | `ACCESS_CODE_DEMO` | Complete, with download and print | Uncapped by default |
| Sales | `ACCESS_CODE_SALES` | Headline verdict and measurements; the coaching detail is withheld | One by default |

Codes are compared case-insensitively with surrounding whitespace trimmed, so a code read aloud or copied off a slide still works.

**The browser gate is not the control.** `public/access-gate.js` covers the page so visitors see a code prompt instead of a live product, but it is bypassable by anyone reading the page source. The restriction that matters is server-side: `/api/conversation`, `/api/analyze` and `/api/interview-feedback` each require a session token issued by `/api/access`, and the trial run is charged inside `/api/conversation` — the moment conversational-video billing begins. Reloading the page therefore cannot buy additional sessions, and the codes themselves are never sent to the browser.

Sessions are held in server memory with a four-hour sliding expiry. A redeploy clears them, which allows at most a few extra trial runs; persisting them would mean introducing a database for a demo gate.

On the sales tier the withheld sections — presence, the voice narrative, line-by-line corrections, the model answer, and all but the first strength and improvement — are **removed from the response** by `redactForTier()` in `access.js` rather than hidden with CSS. They are consequently absent from the page source, from Print / Save as PDF and from the HTML export. The report shows a locked placeholder in their place, alongside a link to the free consultation.

Set `CALENDLY_URL` to the booking link for that consultation. If it is unset the booking card is hidden rather than shown broken, and the server says so at startup.

### Session duration

`TAVUS_MAX_CALL_SECONDS` (default `300`) caps a session at five minutes, enforced in two places: Tavus terminates the conversation server-side, and the in-call countdown ends the session and loads the report. The countdown is computed from the wall clock on each tick rather than by counting intervals, so a backgrounded tab — where browsers throttle timers — still cuts off on schedule.

## Getting started

### Prerequisites

- Node.js 18 or later
- A [Groq](https://console.groq.com) API key
- A [Tavus](https://tavus.io) API key

> **Credentials.** All API keys are supplied through environment variables and are read only on the server. `.env` is git-ignored and is never committed; `.env.example` documents every variable the application expects. In deployment the same variables are set through the hosting platform rather than as a file.

### Installation

```bash
git clone <repository-url>
cd qfwork
npm install
cp .env.example .env
```

Add your `GROQ_API_KEY` and `TAVUS_API_KEY` to `.env`, then provision the AI personas:

```bash
npm run setup
```

This creates both personas on your Tavus account and prints their ids along with the available replica faces. Copy `TAVUS_PERSONA_ID`, `TAVUS_PRESENTATION_PERSONA_ID` and `TAVUS_REPLICA_ID` into `.env`.

### Running

```bash
npm start
```

The application is served at `http://localhost:3000`. The startup output confirms which credentials were found and whether the perception layer is active on both personas:

```
QFwork.ai server listening on http://localhost:3000
  Groq   : configured  (feedback report, speech-to-text)
  Tavus  : configured  (live conversational video)
  Static : serving /public
  Access : demo code configured (unlimited runs)  ·  sales code configured (1 run(s))
  Booking: configured  (free-consultation link on the report)
  Vision : interviewer  persona - perception layer ready (raven-1)
  Vision : presentation persona - perception layer ready (raven-1)
```

Run `npm run check` at any time to verify that the configured personas belong to the current API key.

## Configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `GROQ_API_KEY` | Yes | Feedback report and speech-to-text |
| `TAVUS_API_KEY` | Yes | Conversational video and camera perception |
| `TAVUS_REPLICA_ID` | Yes | The AI partner's appearance |
| `TAVUS_PERSONA_ID` | Yes | Interviewer behaviour and perception queries |
| `TAVUS_PRESENTATION_PERSONA_ID` | Recommended | Presentation audience; falls back to the interviewer persona if unset |
| `TAVUS_MAX_CALL_SECONDS` | No | Per-session duration cap, default `300` |
| `TAVUS_CALLBACK_URL` | No | Webhook endpoint for Tavus events |
| `ACCESS_CODE_DEMO` | Yes¹ | Full-report access code |
| `ACCESS_CODE_SALES` | Yes¹ | Partial-report access code for prospects |
| `TRIAL_RUNS_DEMO` | No | Sessions per demo visitor; `0` or blank means unlimited |
| `TRIAL_RUNS_SALES` | No | Sessions per sales visitor, default `1` |
| `CALENDLY_URL` | Recommended | Free-consultation booking link; the card is hidden if unset |
| `PORT` | No | Server port, default `3000`; set automatically by most hosts |

¹ At least one of the two access codes must be set. With neither, the trial is closed to every visitor and the server reports this at startup.

Personas are bound to the Tavus account that created them. After changing `TAVUS_API_KEY`, re-run `npm run setup` and update both persona ids.

## Deployment

The application requires a persistent Node process. It is not compatible with stateless serverless platforms, for three reasons: audio uploads exceed typical request-body limits, the recording is held in memory between two requests, and report generation legitimately runs for up to a minute.

Any container or VM host is suitable. Deployment consists of:

1. Setting the environment variables listed above on the host.
2. Running `npm install && npm start`.

`PORT` is supplied by the platform and is respected automatically. `.env` is excluded from version control and should never be deployed as a file.

## Project structure

```
├── server.js              Routes, scenario definitions, request orchestration
├── feedback.js            Grading rubrics and report generation
├── voice-metrics.js       Pitch and loudness DSP, speech timing, clarity scoring
├── tavus.js               Conversational video API client, transcript extraction
├── access.js              Access codes, trial sessions, run limits, report gating
├── setup-tavus.js         One-time persona provisioning
├── check-tavus.js         Configuration diagnostics
└── public/
    ├── exam.html          Main application interface
    ├── index.html         Text-based practice mode
    ├── access-gate.js     Access-code prompt shared by both pages
    ├── pcm-worklet.js     Audio capture worklet
    ├── img/               Landing-page photography (placeholders — see below)
    └── logo.png           Brand mark
```

### Landing-page photography

Both landing pages show a four-image showcase drawn from `public/img/`. The repository ships placeholder SVGs. To use real photographs, save them as `showcase-1.jpg` through `showcase-4.jpg` in that folder and update the four `src` attributes in `public/exam.html` and `public/index.html`. Images are lazily loaded and fall back to a neutral tile if a file is missing, so the section cannot break the page. Landscape crops around 8:5 fit the layout without cropping.

## API

Endpoints marked **gated** require the `X-QF-Access` header carrying a session token from `/api/access`.

| Endpoint | Gated | Purpose |
| --- | --- | --- |
| `POST /api/access` | — | Exchange an access code for a trial session |
| `GET /api/access/verify` | — | Confirm a session is still valid |
| `POST /api/conversation` | Yes | Start a session; returns a session id and video-room URL. Charges one trial run |
| `POST /api/voice-sample/:conversationId` | — | Upload the recorded audio (WAV request body) |
| `POST /api/interview-feedback` | Yes | Generate the report from transcript, audio and perception data |
| `POST /api/abandon` | — | End an abandoned session |
| `POST /api/analyze` | Yes | Text-only feedback, used by the text practice mode |
| `GET /health` | — | Liveness probe |

`/api/access` is rate-limited to eight attempts per IP per minute. `/api/abandon` is deliberately ungated: it only ever stops billing, and it is delivered by `sendBeacon`, which cannot set headers.

## Development notes

- Append `?demo=feedback` to the main page to render a complete report from sample data. This exercises the full report layout and the export buttons without consuming conversational video minutes. Add `&tier=sales` to preview the gated report a prospect receives. Both still require an access code.
- Headphones are recommended during sessions. Echo cancellation removes most of the AI partner's voice from the recording, but headphones produce the cleanest input for the voice analysis.
- The browser requests microphone access twice: once for the video session and once for the parallel recording.
- Conversational video is billed per minute. Prefer the demo route for interface work and reserve live sessions for testing the conversation itself.
