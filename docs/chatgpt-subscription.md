# ChatGPT subscription in Xenon AI

Xenon can use the Codex allowance in a ChatGPT account for chat, images, Xenon
commands, and the AI features that use text generation. This is a separate
connection mode from the metered OpenAI API key option.

## Connect

1. Install **Codex CLI 0.153.4 or newer** on the computer running Xenon:
   `npm install -g @openai/codex`. Restart Xenon after installing or updating it.
2. Open **Settings → Xenon AI → ChatGPT (OpenAI)** on that computer.
3. Set **Connection → ChatGPT subscription (via Codex)**.
4. Click **Sign in with ChatGPT** and finish signing in in the browser.
   The panel updates when the connection is ready.
5. Leave **Model → Auto** to use Codex's account default, or select a model
   available to that account. API and subscription model selections are saved
   independently.

The ChatGPT plan/workspace must permit Codex access. Usage counts against its
Codex limits. Selecting subscription mode never falls back to paid API calls.
Use **Check connection** after reconnecting or returning from the browser.
**Disconnect** signs out Xenon's profile or cancels a pending sign-in.

## Troubleshooting

If sign-in says to restart the backend, the settings page has updated but the
running Node service has not. Restart the Xenon backend and then reload Settings;
refreshing the page or reopening the Windows native window alone does not
restart that service. For a development checkout use `npm run dev`. If the
existing backend runs as Administrator, run the restart with that same privilege.

An empty or incomplete HTTP response now displays recovery instructions instead
of a JSON parsing error. Account controls remain restricted to the PC running
Xenon; open its local dashboard to connect or disconnect.

## Voice

Subscription mode uses Xenon's existing local Whisper transcription and Edge
TTS. Install Whisper from **Local (Ollama) → Components** before using the
microphone, then switch back to ChatGPT. Text chat requires no speech setup.
Edge TTS requires an internet connection. This connection does not provide the
ChatGPT app's Voice mode or credits for OpenAI's audio API. Live Voice remains
the existing Gemini feature.

Thai replies select a Thai Edge voice even when the dashboard menus are in
English. Local speech recognition detects the spoken language automatically;
English menus do not force Thai speech into English transcription. Missing
Whisper is reported before the microphone opens. If voice generation or playback fails, the reply stays visible with an
error and the microphone stays closed. Tap to close the voice screen and retry.

## Account and tool isolation

The official Codex app server manages OAuth and token refresh. Its profile is
stored under `server/data/chatgpt/`, which is excluded from static file serving
and Xenon's backup export. Xenon exposes only connection state, account email,
and plan to its local settings panel. It does not read or copy tokens from an
existing Codex login, so connecting/disconnecting Xenon leaves that login alone.
Account setup and model discovery are restricted to the PC's loopback door.

Each request uses an ephemeral thread with Xenon's supplied history. Codex's
environment access and shell tools are disabled, the sandbox is read-only,
and approval requests are refused. Xenon declares only the tools enabled for
that request and executes them through its existing action checks. An expired
session, unsupported CLI, failed turn, or exhausted quota produces an error;
actions are never automatically replayed through another provider.

## Verification

Run `node --test server/test/ai-chatgpt.test.mjs server/test/ai-providers.test.mjs server/test/remote-access.test.mjs`.
Coverage includes account redaction, login/logout, model pagination, images,
tool allowlists, concurrent history isolation, timeouts, and process recovery.
The real local Codex handshake and ephemeral thread creation were checked
without sending a model turn. Login and a live model reply still require the
user to complete sign-in.

See official OpenAI documentation for [authentication](https://learn.chatgpt.com/docs/auth)
and [Codex App Server](https://learn.chatgpt.com/docs/app-server).
