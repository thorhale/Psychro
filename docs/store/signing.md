# Signing and release builds

The `android/` and `ios/` projects are committed and compile today. What is
missing is only credentials. Nothing below requires new engineering — it is
configuration plus repository secrets.

CI currently builds an **unsigned Android debug APK** and **compiles the iOS
project with signing disabled**, which proves both projects stay buildable
without anyone holding an account. Wiring in real signing turns those into
release artifacts.

## Android — Google Play

### 1. Create an upload keystore

Do this once, on a machine you control. **Back it up somewhere durable** — losing
it means you can never update the app under the same listing without Google's
key-reset process.

```bash
keytool -genkey -v \
  -keystore upload-keystore.jks \
  -alias upload \
  -keyalg RSA -keysize 2048 -validity 10000
```

### 2. Add repository secrets

Settings → Secrets and variables → Actions:

| Secret | Value |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | `base64 -w0 upload-keystore.jks` |
| `ANDROID_KEYSTORE_PASSWORD` | keystore password |
| `ANDROID_KEY_ALIAS` | `upload` |
| `ANDROID_KEY_PASSWORD` | key password |

### 3. Wire the signing config

In `android/app/build.gradle`, inside `android { }`:

```gradle
signingConfigs {
    release {
        storeFile file(System.getenv("ANDROID_KEYSTORE_PATH") ?: "upload-keystore.jks")
        storePassword System.getenv("ANDROID_KEYSTORE_PASSWORD")
        keyAlias System.getenv("ANDROID_KEY_ALIAS")
        keyPassword System.getenv("ANDROID_KEY_PASSWORD")
    }
}
buildTypes {
    release {
        signingConfig signingConfigs.release
        minifyEnabled false   // the web bundle is already minified
    }
}
```

Keep the keystore out of git — it is covered by `.gitignore`, but check before
committing.

### 4. Build a release bundle

Play wants an AAB, not an APK:

```bash
npm run build && npx cap sync android
cd android && ./gradlew bundleRelease
# → android/app/build/outputs/bundle/release/app-release.aab
```

### 5. Enable the CI release job

In `.github/workflows/native.yml`, the `android` job's release step is present
but gated on the secrets existing. Once they are set it produces a signed AAB as
a workflow artifact.

## iOS — App Store

Requires an Apple Developer Program membership (paid) and a macOS machine or
macOS CI runner. `xcodebuild` cannot sign without a real certificate.

### 1. Apple Developer portal

- Register the App ID `com.streamdatacenters.psychro`
- Create an **App Store distribution certificate**
- Create an **App Store provisioning profile** for that App ID
- Create the app record in App Store Connect

### 2. Add repository secrets

| Secret | Value |
|---|---|
| `IOS_CERTIFICATE_BASE64` | base64 of the `.p12` distribution certificate |
| `IOS_CERTIFICATE_PASSWORD` | `.p12` export password |
| `IOS_PROVISIONING_PROFILE_BASE64` | base64 of the `.mobileprovision` |
| `IOS_TEAM_ID` | 10-character Apple team ID |
| `APP_STORE_CONNECT_KEY_ID` / `_ISSUER_ID` / `_PRIVATE_KEY` | App Store Connect API key, for automated upload |

### 3. Archive and export

```bash
npm run build && npx cap sync ios
cd ios/App
xcodebuild -workspace App.xcworkspace -scheme App \
  -configuration Release -archivePath build/App.xcarchive archive
xcodebuild -exportArchive -archivePath build/App.xcarchive \
  -exportOptionsPlist ExportOptions.plist -exportPath build/
```

`ExportOptions.plist` needs `method: app-store` and your `teamID`.

### 4. Privacy manifest

`ios/App/App/PrivacyInfo.xcprivacy` is committed and declares no tracking, no
collected data types, and no required-reason APIs. Verify it is included in the
target's **Copy Bundle Resources** build phase — Xcode usually adds it
automatically, but a missing privacy manifest is an App Store rejection.

## Version numbering

The `version` in `package.json` is the source of truth: it drives the in-app
footer stamp and the service-worker cache key. Keep the native versions in step
before every submission.

| Where | Field | Example for 2.1.0 |
|---|---|---|
| `package.json` | `version` | `2.1.0` |
| `android/app/build.gradle` | `versionName` | `2.1.0` |
| `android/app/build.gradle` | `versionCode` | monotonic integer, e.g. `20100` |
| `ios/App/App.xcodeproj` | `MARKETING_VERSION` | `2.1.0` |
| `ios/App/App.xcodeproj` | `CURRENT_PROJECT_VERSION` | monotonic integer |

Both stores reject a build whose version code has been used before, so bump the
integer even for a re-upload of the same marketing version.

## What CI does today, without any credentials

- **Android**: `./gradlew assembleDebug` → unsigned APK uploaded as an artifact.
  Installable on a device with developer mode for testing.
- **iOS**: `xcodebuild build CODE_SIGNING_ALLOWED=NO` → proves the project
  compiles and the plugins link. Non-blocking and manually triggered, since macOS
  runners are billed at a higher rate.

Both exist so that a change to the web app which breaks the native shells is
caught at the commit that causes it, not months later when someone finally tries
to ship.
