package expo.modules.footagetransfer

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.wifi.WifiManager
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Build
import android.os.PowerManager
import android.util.Log
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicBoolean

class TransferForegroundService : Service() {
  private val stopped = AtomicBoolean(false)
  private val handler = Handler(Looper.getMainLooper())
  private var started = false
  private var jobId: String? = null
  private var executionWakeLock: PowerManager.WakeLock? = null
  private var executionWifiLock: WifiManager.WifiLock? = null
  private var stopReason = "Android stopped the transfer service. Reopen and continue to reconcile progress."
  private val executionWindowExpired = Runnable {
    stopReason = "The background transfer window ended. Reopen and continue from confirmed progress."
    stopped.set(true)
    try { releaseExecutionResources() }
    finally {
      stopForeground(STOP_FOREGROUND_REMOVE)
      stopSelf()
    }
  }
  private val updateNotification = object : Runnable {
    override fun run() {
      if (stopped.get()) return
      getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification())
      handler.postDelayed(this, 1_000)
    }
  }

  @Suppress("DEPRECATION") // API 26–33: high-performance Wi-Fi locks remain effective with the screen off. UIDT owns API 34+.
  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    startForeground(NOTIFICATION_ID, notification())
    if (!started) {
      started = true
      val owner = TransferOwner.get(this)
      jobId = owner.store.current()?.id
      val power = getSystemService(PowerManager::class.java)
      executionWakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, CPU_WAKE_TAG).apply { setReferenceCounted(false) }
      try {
        executionWakeLock?.acquire(EXECUTION_WINDOW_MS)
        val connectivity = getSystemService(ConnectivityManager::class.java)
        val usingWifi = connectivity.getNetworkCapabilities(connectivity.activeNetwork)?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true
        if (Build.VERSION.SDK_INT < 34 && usingWifi) {
          executionWifiLock = applicationContext.getSystemService(WifiManager::class.java)
            .createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, WIFI_WAKE_TAG).apply { setReferenceCounted(false) }
          executionWifiLock?.acquire()
        }
      } catch (error: RuntimeException) {
        try {
          releaseExecutionResources()
          jobId?.let { id -> owner.store.update(id) {
            if (it.phase is Phase.Cancelled || it.phase is Phase.Received) it
            else it.copy(phase = Phase.Failed("Android could not acquire background execution resources.", false))
          } }
          Log.e("FootageTransfer", JSONObject().put("event", "execution_lease_rejected").put("jobId", jobId)
            .put("errorType", error.javaClass.simpleName).toString())
        } finally {
          stopForeground(STOP_FOREGROUND_REMOVE)
          stopSelf()
        }
        return START_NOT_STICKY
      }
      Log.i("FootageTransfer", JSONObject().put("event", "execution_lease_acquired").put("jobId", jobId)
        .put("cpuHeld", executionWakeLock?.isHeld == true).put("wifiHeld", executionWifiLock?.isHeld == true)
        .put("timeoutMs", EXECUTION_WINDOW_MS).put("powerSaveEnabled", power.isPowerSaveMode).toString())
      handler.postDelayed(executionWindowExpired, EXECUTION_WINDOW_MS)
      handler.post(updateNotification)
      TransferOwner.get(this).run(stopped) {
        handler.post {
          if (!stopped.get()) {
            handler.removeCallbacks(updateNotification)
            handler.removeCallbacks(executionWindowExpired)
            try { releaseExecutionResources() }
            finally {
              stopForeground(STOP_FOREGROUND_REMOVE)
              stopSelf()
            }
          }
        }
      }
    }
    // Do not promise autonomous process-death recovery or restart work without a visible user action.
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    stopped.set(true)
    handler.removeCallbacks(updateNotification)
    handler.removeCallbacks(executionWindowExpired)
    try { releaseExecutionResources() }
    finally {
      try {
        val owner = TransferOwner.get(this)
        jobId?.let { id -> owner.store.update(id) {
          if (it.phase is Phase.Ready || it.phase is Phase.Uploading || it.phase is Phase.Waiting || it.phase is Phase.Verifying)
            it.copy(phase = Phase.Waiting(stopReason))
          else it
        } }
      } finally { super.onDestroy() }
    }
  }

  private fun releaseExecutionResources() {
    val wifiLock = executionWifiLock
    val wakeLock = executionWakeLock
    executionWifiLock = null
    executionWakeLock = null
    val cpuHeld = wakeLock?.isHeld == true
    val wifiHeld = wifiLock?.isHeld == true
    try { if (wifiHeld) wifiLock?.release() }
    finally {
      if (cpuHeld) wakeLock?.release()
      if (cpuHeld || wifiHeld) Log.i("FootageTransfer", JSONObject().put("event", "execution_lease_released")
        .put("jobId", jobId).put("cpuReleased", cpuHeld).put("wifiReleased", wifiHeld).toString())
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  private fun notification(): Notification {
    val manager = getSystemService(NotificationManager::class.java)
    val builder = if (Build.VERSION.SDK_INT >= 26) {
      manager.createNotificationChannel(NotificationChannel(CHANNEL, "Original video transfer", NotificationManager.IMPORTANCE_LOW))
      Notification.Builder(this, CHANNEL)
    } else Notification.Builder(this)
    val job = TransferOwner.get(this).store.current()
    val text = when (val phase = job?.phase) {
      is Phase.Waiting -> phase.reason
      Phase.Verifying -> "Checking the received original."
      is Phase.Received -> "Original verified."
      is Phase.Cancelled -> "Cancelled locally."
      is Phase.Failed -> "Transfer needs attention. Open Footage."
      else -> "Sending your original. Open Footage for confirmed progress."
    }
    builder.setSmallIcon(android.R.drawable.stat_sys_upload)
      .setContentTitle("Footage original transfer")
      .setContentText(text)
      .setOnlyAlertOnce(true)
      .setOngoing(true)
    if (job != null) builder.setProgress(100, (job.confirmed * 100 / job.asset.bytes).toInt(), false)
    val launch = packageManager.getLaunchIntentForPackage(packageName)
    if (launch != null) builder.setContentIntent(PendingIntent.getActivity(this, 0, launch, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
    return builder.build()
  }

  companion object {
    private const val CPU_WAKE_TAG = "Footage:transfer-cpu"
    private const val WIFI_WAKE_TAG = "Footage:transfer-wifi"
    private const val EXECUTION_WINDOW_MS = 30 * 60 * 1_000L
    private const val CHANNEL = "footage-foreground-transfer"
    private const val NOTIFICATION_ID = 14272
  }
}
