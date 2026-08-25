# Spotify Friend Activity

See what you and your friends are currently playing on Spotify, using the *official*
Web API (not the private buddylist endpoint). Each person connects their own
Spotify account via OAuth, so it's fully within Spotify's terms.

How it works: each friend clicks a personal "Connect Spotify" link, approves
read-only access to their currently-playing track, and their token is stored
on your server. The dashboard polls `/api/friends` every 15s and shows
everyone's live status.

## 1. Create a Spotify app

1. Go to https://developer.spotify.com/dashboard and log in.
2. Click **Create app**.
3. Fill in a name/description, and add this exact Redirect URI:
   `http://127.0.0.1:8888/callback` (or your own domain later).
4. Save. Copy the **Client ID** and **Client Secret** from Settings.

> Note: a new Spotify app starts in **Development Mode**, which caps you at
> 25 users. You'll need to add each friend's Spotify email under
> **Users and Access** in the dashboard before they can log in — Spotify
> requires this allow-list step for dev-mode apps. That's fine for a
> friend-group project.

## 2. Configure

```bash
cd spotify-friends
cp .env.example .env
# edit .env and paste in your Client ID / Client Secret
npm install
```

## 3. Run

```bash
npm start
```

Visit **http://127.0.0.1:8888**. Enter your name, click "Connect Spotify",
approve access. Send the same page to friends (once you've added their
emails in the dashboard) so they can connect too.

## Notes / limitations

- Only shows a *currently playing* track — Spotify's public API has no
  "friend feed" endpoint, so this polls each connected friend individually.
- Tokens are stored in a local `db.json` file (plaintext) for simplicity.
  Fine for personal/local use; don't ship this as-is to the public internet
  without encrypting tokens and using HTTPS.
- Dev-mode apps require you to allow-list each friend's Spotify account
  email before they can authorize. To go past 25 users you'd need to request
  **Extended Quota Mode** from Spotify.
- If a friend disconnects/revokes access, their card will just show
  "Couldn't fetch" — you can add a way to remove them from `db.json` if
  needed.
