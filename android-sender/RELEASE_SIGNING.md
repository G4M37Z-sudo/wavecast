# Release signing for WaveCast Android Sender

By default, `assembleRelease` produces an APK signed with the Android debug keystore. This works for installing on your own devices and for sideloading to friends (they just need to enable "Install from unknown sources"), but it's **not** valid for the Play Store.

If you want to publish to the Play Store, generate a real keystore and configure Gradle to use it.

## Generate a keystore

Run this once. **Save the .jks file and the passwords somewhere safe** — if you lose them, you can never update your app on the Play Store.

```bash
keytool -genkey -v \
  -keystore wavecast-release.jks \
  -alias wavecast \
  -keyalg RSA -keysize 2048 \
  -validity 10000
```

You'll be prompted for:
- A **keystore password** (save this)
- A **key password** (can be the same as the keystore password)
- Your name, organization, country (this becomes the X.500 distinguished name embedded in the cert)

The result is a `wavecast-release.jks` file (~2KB). **Treat it like a private key.**

## Configure Gradle

1. Move the .jks to a safe place **outside the repo** (e.g. `~/keystores/wavecast-release.jks`). Don't commit it.

2. Add to your **user-level** `~/.gradle/gradle.properties` (NOT the project's gradle.properties):

   ```properties
   WAVECAST_KEYSTORE=/Users/you/keystores/wavecast-release.jks
   WAVECAST_KEYSTORE_PASSWORD=your-keystore-password
   WAVECAST_KEY_ALIAS=wavecast
   WAVECAST_KEY_PASSWORD=your-key-password
   ```

3. Edit `android-sender/app/build.gradle` to add a `signingConfigs` block:

   ```groovy
   signingConfigs {
       release {
           storeFile file(System.getenv('WAVECAST_KEYSTORE') ?: project.findProperty('WAVECAST_KEYSTORE'))
           storePassword System.getenv('WAVECAST_KEYSTORE_PASSWORD') ?: project.findProperty('WAVECAST_KEYSTORE_PASSWORD')
           keyAlias System.getenv('WAVECAST_KEY_ALIAS') ?: project.findProperty('WAVECAST_KEY_ALIAS')
           keyPassword System.getenv('WAVECAST_KEY_PASSWORD') ?: project.findProperty('WAVECAST_KEY_PASSWORD')
       }
   }

   buildTypes {
       release {
           signingConfig signingConfigs.release
           minifyEnabled true
           proguardFiles getDefaultProguardFile('proguard-android-optimize.txt'), 'proguard-rules.pro'
       }
   }
   ```

4. Build:

   ```bash
   ./gradlew assembleRelease
   # Output: app/build/outputs/apk/release/app-release.apk
   ```

## Verify the signature

```bash
$ apksigner verify --print-certs app/build/outputs/apk/release/app-release.apk
```

You should see your cert info, not the Android debug cert.

## Upload to Play Store

1. Create a Google Play Console account ($25 one-time fee)
2. Create a new app, fill in the listing
3. Go to **Release management → App releases → Production**
4. Upload the signed APK
5. Fill in content rating, target audience, etc.
6. Submit for review (first submission takes a few days; updates are hours)

## Sideloading without the Play Store

Even with a release-signed APK, you can share it directly. Just upload the .apk somewhere (Drive, Dropbox, your own server) and have people tap the link on their phone. They'll need to enable "Install from unknown sources" for your browser/file manager.

For the WaveCast case, I'd recommend **just sharing the debug-signed APK** until you have a real reason to publish. Debug-signed APKs work fine for sideloading; only the Play Store requires release signing.
