# Sharify — Real-time Social Music Hub & Playback Sync

Sharify transforms Spotify into a private, real-time social music lounge for you and your circle. See what your friends are playing, sync and listen along to tracks in real-time, vibe in the real-time chat lounge, share interactive song cards, compare music tastes, and generate Spotify Blend playlists.

---

## 🌟 Key Features

* **🎧 Selective Friend Network**: Your feed only displays tracks from friends you've added (or invited via your unique Friend Code `SHAR-XXXX` or QR code).
* **📻 1-Click "Listen Along" (Sync Playback)**: Jump directly to the exact song and live timestamp a friend is listening to on your own Spotify player with one click.
* **💬 Real-Time Music Lounge & Chat**: Built-in chat room with typing indicators, live message streams, and a 1-click **"Share What I'm Playing"** button that embeds interactive song cards right into the conversation.
* **🔥 Live Floating Reactions**: Send instant emoji reactions (🔥, ❤️, 🕺, ⚡, ☕, 💀) that float in real-time across friend cards.
* **✨ Music Taste Match & Spotify Blend**: Calculate your musical compatibility score with any friend based on top artists and genres, and auto-generate an official "Sharify Blend" playlist in Spotify.
* **📱 Instant QR Code & Invite System**: Share your unique invite QR code or link so nearby friends can scan with their phone camera to instantly connect and be added to your circle.
* **🔊 30-Second Audio Previews**: Sample tracks directly in the browser before queueing or syncing.
* **🎨 Ambient Visuals & Live Equalizer**: Cards feature animated equalizer frequency bars and dynamic backlights.

---

## 🚀 Quickstart Guide

### 1. Spotify App Setup
1. Go to the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) and log in.
2. Click **Create app** (or use an existing app).
3. Set the **Redirect URI** to:
   `http://127.0.0.1:8888/callback` (or your public tunnel URL: `https://your-tunnel.loca.lt/callback`).
4. Copy the **Client ID** and **Client Secret** from the app settings.
5. In **Users and Access**, add the Spotify account emails of your friends (required for Development mode apps).

### 2. Configure Environment
Copy `.env.example` to `.env` and fill in your credentials:
```env
SPOTIFY_CLIENT_ID=your_client_id_here
SPOTIFY_CLIENT_SECRET=your_client_secret_here
REDIRECT_URI=http://127.0.0.1:8888/callback
PORT=8888
SESSION_SECRET=a-secure-random-string
```

### 3. Install & Start
```bash
npm install
npm start
```
Visit **http://127.0.0.1:8888** in your browser.

---

## 🌐 Public Sharing (Localtunnel)
To share your local instance over the internet with friends:
```bash
node tunnel.js
```
Copy the generated tunnel URL and add `<tunnel_url>/callback` to your Spotify Developer Dashboard redirect URIs.
