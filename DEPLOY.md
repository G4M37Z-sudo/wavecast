# Deploying WaveCast

WaveCast needs **persistent WebSocket connections** and **in-memory state** to work, so it does NOT work on Vercel/Netlify-style serverless hosts. Use a host that supports long-lived Node processes.

## ✅ Recommended: Render.com (5 minutes)

Render's free tier runs a real Node process, supports WebSockets, and gives you a public HTTPS URL.

1. **Push the code** (already done — it's on GitHub at `G4M37Z-sudo/wavecast`).
2. **Go to https://render.com** and sign in with your GitHub account.
3. Click **New +** → **Blueprint**.
4. Connect the `G4M37Z-sudo/wavecast` repo.
5. Render will auto-detect `render.yaml` and show the service config.
6. Click **Apply** (or "Create Service").
7. Wait ~2–3 minutes for the first deploy.
8. Once live, Render gives you a URL like **`https://wavecast.onrender.com`**.

That's it. Open the URL on two devices on the same network (or anywhere with WebRTC peer-to-peer reachability) and start casting.

### Free tier caveats

- The service **sleeps after 15 minutes of inactivity**. The first cast after a sleep takes ~30s while it wakes up. Subsequent casts are instant.
- For always-on availability, upgrade to the $7/mo **Starter** plan (one click in the Render dashboard).

## Alternative: Railway.app (~$5/mo)

1. Go to https://railway.app → New Project → Deploy from GitHub repo
2. Select `G4M37Z-sudo/wavecast`
3. Railway auto-detects Node and runs `npm start`
4. Add a public domain in the Settings tab
5. Done.

Railway's free trial gives $5 of credit, then it's ~$5/mo to keep running.

## Alternative: Fly.io (free tier, 3 VMs)

1. `npm install -g flyctl`
2. `fly launch` in the project root (it'll auto-detect Node)
3. `fly deploy`
4. Open the URL fly gives you.

## ❌ Hosts that won't work

- **Vercel** — serverless functions can't hold WebSocket connections
- **Netlify** — same
- **Cloudflare Pages** — same
- **GitHub Pages** — static-only, no Node server

These will deploy the static HTML but the cast/connect buttons will fail because the WebSocket signaling can't run.

## Local dev

If you don't want to deploy yet:

```bash
git clone git@github.com:G4M37Z-sudo/wavecast.git
cd wavecast
npm install
npm start
```

Then open `http://localhost:8080/sender` and `http://localhost:8080/receiver`.
