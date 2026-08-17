# Slate — a time-blocking scheduler

A dark, FlowSavvy-inspired weekly calendar that auto-schedules your tasks into
your work/private hours, splits long tasks into segments, lets you drag
blocks to adjust them, and (optionally) syncs your schedule to your own
Google Drive so the same data shows up on your phone and your computer.

Everything runs in the browser — there's no backend server, no database, and
no cost to run this beyond the free tiers of the services below.

---

## What you're setting up, in one sentence

You'll (1) put this code on GitHub, (2) turn on GitHub Pages so it's a real
website, and (3) optionally create a free Google OAuth Client ID so the app
can read/write one JSON file in your Drive. Steps 1–2 take about five
minutes; step 3 takes about five more and can be done any time later.

---

## 1. Get the code onto GitHub

1. Create a new repository on GitHub (Public — see the note below on why
   that's fine). Don't initialize it with a README, since you already have
   one here.
2. From this project's folder, run:
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/<your-username>/<your-repo>.git
   git push -u origin main
   ```

**Why public is fine:** nothing sensitive lives in this code. The Google
Client ID (set up in step 3) is meant to be visible in client-side apps —
it identifies the app, it isn't a password. Your actual schedule data never
touches this repo; it stays in your browser and, optionally, your own Drive.

---

## 2. Turn on GitHub Pages

1. In your new repo, go to **Settings → Pages**.
2. Under "Build and deployment" → **Source**, choose **GitHub Actions**
   (not "Deploy from a branch" — this repo already includes the workflow
   file that builds and deploys automatically).
3. Push a commit to `main` (or go to the **Actions** tab and manually run
   the "Deploy to GitHub Pages" workflow). Wait for it to go green —
   usually under a minute.
4. Your app is now live at:
   ```
   https://<your-username>.github.io/<your-repo>/
   ```
   Open it. The scheduler works immediately — tasks, drag-to-reschedule,
   the weekly review, undo — all of it, with data saved locally in your
   browser. Google Drive sync (below) is optional on top of that.

Every time you push a change to `main`, it redeploys automatically.

---

## 3. (Optional) Turn on Google Drive sync

This lets the app keep one JSON file in your own Drive up to date, so
opening the same URL on your phone shows the same schedule.

### 3a. Create a Google Cloud project and enable the Drive API
1. Go to **console.cloud.google.com** and create a new project (or use an
   existing one) — this is free, no billing needs to be enabled.
2. Go to **APIs & Services → Library**, search for **Google Drive API**,
   and enable it.

### 3b. Configure the OAuth consent screen
1. Go to **APIs & Services → OAuth consent screen**.
2. Choose **External** as the user type (this is normal for a personal
   Google account) and fill in the required basic fields (app name, your
   email).
3. Under **Audience → Test users**, add your own Google account.
   Leaving the app in "Testing" status means you skip Google's app review
   entirely — completely fine for personal use.

### 3c. Create the OAuth Client ID
1. Go to **APIs & Services → Credentials → Create Credentials → OAuth
   client ID**.
2. Application type: **Web application**.
3. Under **Authorized JavaScript origins**, add your GitHub Pages URL
   *without* a trailing path, e.g.:
   ```
   https://<your-username>.github.io
   ```
   (If you want to test locally too, also add `http://localhost:5173`.)
4. Click Create, then copy the Client ID (it ends in
   `.apps.googleusercontent.com`).

### 3d. Give the deployed app that Client ID
1. In your GitHub repo, go to **Settings → Secrets and variables →
   Actions → New repository secret**.
2. Name: `VITE_GOOGLE_CLIENT_ID`. Value: the Client ID you just copied.
   (It's not sensitive, but a secret is a convenient place to keep it out
   of the committed source.)
3. Re-run the "Deploy to GitHub Pages" workflow (Actions tab → the
   workflow → **Re-run all jobs**) so the build picks it up.

### 3e. Connect it
1. Open your deployed app, click the cloud icon in the header, and
   **Connect Google Drive**.
2. Approve the Google consent screen (you'll see an "unverified app"
   warning since you haven't submitted this for Google's review — click
   **Advanced → Go to Slate (unsafe)** to proceed; this is expected and
   normal for a personal-use app in Testing mode).
3. Do the same thing from your phone's browser, signed into the same
   Google account, and it'll pick up the same schedule.

Google's access tokens for this kind of no-backend setup last about an
hour, so you'll click "Reconnect" occasionally — that's expected, not a
bug.

---

## Running it locally (optional, for making changes)

```bash
npm install
cp .env.example .env.local   # then paste your Client ID in, if using Drive sync
npm run dev
```
Opens at `http://localhost:5173`. `npm run build` produces the same
`dist/` folder GitHub Actions builds for you.

---

## Installing it as an app on your phone

Once it's deployed, open the URL in Chrome on Android and use **Add to
Home Screen** — it installs with its own icon and opens full-screen, no
browser chrome, thanks to the included web app manifest.

---

## What lives where

- **Tasks, blocked hours, work/private ranges, completion history** — saved
  instantly to your browser's local storage, and (if connected) mirrored to
  one `slate-schedule.json` file in your Drive, created by the app using
  the narrow `drive.file` scope (it can only ever see files it creates
  itself — never the rest of your Drive).
- **No server, no database, no analytics.** The only network calls this app
  makes are directly from your browser to `accounts.google.com` and
  `www.googleapis.com`, and only once you click Connect.
