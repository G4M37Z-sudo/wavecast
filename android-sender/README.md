# WaveCast Android Sender

Native Android app that captures the device screen and casts it to a WaveCast receiver (browser-based `/receiver` page) over WebRTC.

## How it fits in

```
Android phone (this app)            WaveCast server             Browser receiver
  ┌─────────────────────┐           ┌──────────────┐             ┌──────────────┐
  │  MediaProjection ───┼─WebRTC P2P┼→ (relay SDP) │             │  /receiver   │
  │  ScreenCapturerAndroid          │              │             │  <video>     │
  │  ↓                              │              │             │              │
  │  PeerConnection.sendonly        │              │             │              │
  │  ↑                              │              │             │              │
  │  /ws/presence + /ws/room ───────┼─signaling────┼─WebSocket──→│  /ws         │
  └─────────────────────┘           └──────────────┘             └──────────────┘
```

The same signaling server that the web sender uses (deployed at https://g4m37z-wifi-cast.onrender.com) accepts Android clients. The browser at `/receiver` doesn't need to know whether the sender is a browser or an app — it just receives a WebRTC stream.

## What this gives you

- **Cast your phone's screen to any browser** — open `/receiver` on a laptop, TV, or another phone, and the Android sender streams to it
- **Same code pairing** as the web sender — type a 6-character code to pair with a specific receiver
- **Discovery** — receivers on the same network show up in the Android app's list
- **TURN/STUN-ready** — uses Google's public STUN servers; for restrictive networks you can add your own TURN server in `WebRtcManager.kt`

## What this doesn't give you (yet)

- **Audio**: system audio capture is wired up but disabled by default. Enable `includeAudio` in `CastService.startCast` once you've tested video.
- **Foreground/background switching**: the foreground service keeps the cast alive even when the app is backgrounded, but switching apps during a cast will show a "WaveCast is casting" notification. This is intentional and required by Android.
- **Quality controls**: video is captured at full screen resolution at 30fps. There's no UI for resolution/fps yet.
- **Recording**: not implemented; the captured frames only go to the WebRTC PeerConnection.

## Build

### Prerequisites

- **Android Studio** Hedgehog (2023.1.1) or later
- **JDK 17** (bundled with Android Studio)
- **Android SDK 34** (installed via Android Studio's SDK manager)
- An Android device or emulator running **Android 7.0 (API 24) or later**

### Open the project

1. Open Android Studio
2. File → Open → select the `android-sender/` directory
3. Wait for Gradle sync (downloads ~200MB of dependencies on first run)
4. Plug in your phone with USB debugging enabled
5. Click Run ▶ (or press Shift+F10)

The first build takes 5-10 minutes. Subsequent builds are ~30 seconds.

### Build a release APK (for sideloading)

```bash
cd android-sender
./gradlew assembleRelease
# Output: app/build/outputs/apk/release/app-release-unsigned.apk
```

The release APK is signed with the debug keystore as a placeholder. To install:

```bash
adb install -r app/build/outputs/apk/release/app-release.apk
```

For real distribution (Play Store, friends you don't want to grant USB debugging to), see [RELEASE_SIGNING.md](./RELEASE_SIGNING.md) for keystore setup.

## Run

1. Launch **WaveCast Sender** on your phone
2. On another device, open `https://g4m37z-wifi-cast.onrender.com/receiver`
3. The receiver should show up in the Android app's "Receivers on this network" list within a few seconds
4. Tap **Connect** on the receiver, OR enter the code shown on the receiver page
5. Tap **Start screen cast**
6. Android shows the system dialog: "WaveCast will start capturing everything on your screen"
7. Tap **Start now**
8. Your phone's screen is now streaming to the receiver

To stop, swipe down the notification shade and tap **Stop**, or kill the foreground service from Android's app info screen.

## How it works (architecture)

| File | Purpose |
|---|---|
| `MainActivity.kt` | UI: device name, server URL, receivers list, code input, start button |
| `CastService.kt` | Foreground service that owns the MediaProjection and PeerConnection |
| `WebRtcManager.kt` | PeerConnectionFactory + ScreenCapturerAndroid + transceivers + SDP |
| `SignalingClient.kt` | WebSocket client (OkHttp) speaking the same protocol as the web sender |
| `ReceiverAdapter.kt` | RecyclerView adapter for the discovered-receivers list |
| `activity_main.xml` | Layout: scrollable card with name input, server URL, list, code join, start button |
| `AndroidManifest.xml` | Declares permissions, the service, and the activity |

The flow is:
1. **MainActivity** connects to `/ws/presence` to discover receivers
2. User taps **Start screen cast** → Android requests MediaProjection permission
3. On grant, **CastService** starts as a foreground service
4. **CastService** connects to `/ws/<room>` and starts a **WebRtcManager**
5. **WebRtcManager** creates a ScreenCapturerAndroid bound to the MediaProjection, creates a PeerConnection with explicit sendonly transceivers, generates an SDP offer
6. Offer → `SignalingClient.sendOffer` → relayed to the receiver
7. Receiver's answer comes back via `/ws/<room>` → applied to the PeerConnection
8. ICE candidates flow both ways through the same WebSocket
9. WebRTC peer connection becomes connected → frames flow P2P from Android to the browser

## Customizing

- **Server URL**: change in the app's settings (or hardcode `DEFAULT_SERVER_URL` in `MainActivity.kt`)
- **App name / package**: edit `app/build.gradle` and `AndroidManifest.xml`
- **Theme colors**: edit `res/values/themes.xml` and `res/values/colors.xml`
- **TURN server**: add to `iceServers` list in `WebRtcManager.buildPeerConnection`

## Known issues

- Some OEM skins (Xiaomi MIUI, Huawei EMUI) aggressively kill background services. If the cast drops, check Settings → Apps → WaveCast → Battery → "No restrictions".
- The web view of the receiver may take 1-2 seconds to start rendering after the connection is established. This is a browser autoplay thing, not a WaveCast bug.

## License

Same as the rest of WaveCast: MIT.
