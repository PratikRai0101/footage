# Android 13 screen-off transfer fix

Recorded 29 October 2026. A generated video reached a verified receipt after 350.8 seconds of continuous screen-off Wi-Fi transfer. Power saving stayed enabled. The phone reported Samsung AOD `Dozing`, not deep Doze.

[The machine-readable record](android13-screen-wifi.json) contains the passing run, failed controls, cancellation result, source hashes, and installed APK hash.

## The foreground service now owns execution resources

A foreground notification does not itself keep the CPU or Wi-Fi radio awake. The original service held neither resource.

A controlled test reproduced the stall with cellular disabled and the screen non-interactive. Adding a partial CPU wake lock alone did not fix the uninterrupted repeat. A subsequent screen-off policy probe showed no effective network block on this app.

`TransferForegroundService.kt` now acquires a partial CPU wake lock and, when starting on Wi-Fi, a high-performance Wi-Fi lock. These locks belong to the active foreground transfer, not the activity or JavaScript runtime. The module declares the normal `WAKE_LOCK` permission. No battery exemption or global power-saving change was applied.

The Wi-Fi mode is specific to the API 26 through 33 foreground-service path. API 34 changes that mode's behavior. The app already selects the separate, still hardware-untested user-initiated job path on API 34 and newer.

The service releases resources when its owner finishes, when the service is cancelled or destroyed, and when its 30-minute attempt window ends. Expiry retains the job and asks the user to return and continue. The CPU lock also has an OS timeout. The 30-minute expiry branch has not yet been exercised on hardware.

Native diagnostics record resource ownership and exception classes without logging capabilities, authenticated headers, selected URIs, or file contents. Network timeouts still occur. The passing run recovered from two `SocketTimeoutException` errors without a screen wake or a new upload identity.

## The passing run did not wake the phone to finish

The test used the existing 29,080,346-byte generated H.264/AAC fixture. A streaming HTTP limiter prolonged the real Wi-Fi transfer; it did not replace tus, change the video, buffer a whole video, or issue a test receipt. Separate local tests verify that the limiter preserves request bytes, method overrides, authorization, response offsets, and abort propagation.

The actual phone connected over WLAN to the Mac. USB remained connected for power and Metro, with no upload tunnel. Cellular fallback was disabled. The receiver process was not restarted during this experiment.

The checks established:

- Both execution locks were held before screen-off.
- The same upload that failed the CPU-only test resumed from its retained server offset.
- During the quiet interval, the test observed only the receiver's local file and database. It made no ADB or native-state polls.
- The OS's last-wake timestamp was unchanged from screen-off through receipt. This rejects a run that woke and went back to sleep.
- The receiver and native owner published the same receipt before the test requested a wake or restored cellular data.
- An independent file read matched the generated source's byte count and SHA-256.
- Neither execution lock remained held after the receipt.

The idle-progress failure threshold remained 45 seconds. The test did not pass by increasing native network timeouts or waking the screen.

The earlier CPU-only run completed after a wake event. It remains a rejected continuous-screen-off result. The subsequent CPU-only uninterrupted run stalled. Both records remain in the JSON rather than being replaced with the passing result.

## Visible cancellation also released both locks

A separate generated-fixture upload acquired both locks. The test tapped the real **Cancel upload** control while the app was visible.

Both locks were released. Native cleanup reached its confirmed cancelled state, the receiver retained a cancellation tombstone, the partial server file disappeared, and no receipt was issued. This verifies visible cancellation, not offline cancellation or later cleanup retry.

After both passing cases, Wi-Fi and cellular data were enabled and power saving remained enabled, matching the original flags. The diagnostic receiver field was restored to the direct receiver origin. The test proxy exited, and no transfer service or transfer wake lock remained active.

## Reproduce the controlled test

On an unlocked phone, open the development app and review only the generated `footage-wifi-test.mp4`. Keep the private receiver and Metro running. The tool requires its local and phone fixture hashes to match.

```sh
python3 scripts/device-screen-stress.py --host <Mac-LAN-IP> --label repeat --require-lease --require-wifi-lease --idle-limit 45 --deadline 480
```

Do not touch the phone during the quiet interval. The tool fails if the phone wakes before receipt. Use a fresh evidence label to retain prior results.

For visible cancellation, review the generated fixture again:

```sh
python3 scripts/device-screen-stress.py --host <Mac-LAN-IP> --label cancel-repeat --cancel-only --require-lease --require-wifi-lease
```

The runner restores network flags. It never unlocks the keyguard. If failed-test cleanup cannot reach the Cancel UI, it explicitly stops only this test app and preserves the job. That intervention is recorded and cannot count as autonomous recovery. Restoring an app-only receiver text field can wait for the user to unlock.

Local checks are `npm test`, `npm run test:device-tools`, `npm run typecheck`, and `npm run lint`. The [receiver log](server-tests.tap) has 15 passing tests, and the [device-tool log](device-tool-tests.tap) has two. Native compilation and lint pass, with the same two existing lint warnings. The [APK signature](screen-fix-apk-signature.txt) verifies, and its installed hash matches [the artifact record](artifact.json).

## Limits

This result covers one USB-powered Android 13 phone, generated 720p media, the recorded Wi-Fi conditions, and a limited-duration screen-off test. It is not a throughput benchmark. The earlier full-size Wi-Fi stress scenarios remain failed historical runs, not retroactive passes.

Unplugged operation, deep Doze, cellular transfers, the 30-minute expiry branch, general process-death recovery, 4K/HDR, physical iPhone behavior, and production readiness remain unverified. This historical test preceded the finished UI. The later [final standalone APK check](android13-final-device.md) now verifies that UI on the same physical phone, with its own qualified powered WLAN/AOD/cancellation evidence.

## Android references

- [Set a wake lock](https://developer.android.com/develop/background-work/background-tasks/awake/wakelock/set)
- [Release a wake lock](https://developer.android.com/develop/background-work/background-tasks/awake/wakelock/release)
- [Wake-lock best practices](https://developer.android.com/develop/background-work/background-tasks/awake/wakelock/best-practices)
- [Wi-Fi lock behavior](https://developer.android.com/reference/android/net/wifi/WifiManager.WifiLock)
- [High-performance Wi-Fi mode and API 34 deprecation](https://developer.android.com/reference/android/net/wifi/WifiManager#WIFI_MODE_FULL_HIGH_PERF)
