package expo.modules.footagetransfer

import android.app.job.JobInfo
import android.app.job.JobScheduler
import android.content.ComponentName
import android.content.Intent
import android.content.Context
import android.net.Uri
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Build
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.functions.Queues
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONObject

class FootageTransferModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("FootageTransfer")

    AsyncFunction("device") {
      JSONObject().put("manufacturer", Build.MANUFACTURER).put("model", Build.MODEL)
        .put("apiLevel", Build.VERSION.SDK_INT).put("androidVersion", Build.VERSION.RELEASE)
        .put("supportsTransfer", Build.VERSION.SDK_INT >= 26)
        .put("scheduler", if (Build.VERSION.SDK_INT >= 34) "user-initiated-job" else "foreground-service").toString()
    }
    AsyncFunction("current") { owner().snapshot() }
    AsyncFunction("inspect") Coroutine { source: String ->
      withContext(Dispatchers.IO) {
        VideoMetadata.inspect(appContext.reactContext ?: error("Android context is unavailable."), Uri.parse(source)).json().toString()
      }
    }
    AsyncFunction("settings") {
      val preferences = preferences()
      JSONObject().put("origin", preferences.getString("origin", ""))
        .put("appearance", preferences.getString("appearance", "dark")).toString()
    }
    AsyncFunction("configure", fun(origin: String, appearance: String): Unit {
      require(appearance in listOf("dark", "light", "system")) { "Choose a supported appearance." }
      val normalized = if (origin.isBlank()) "" else receiverOrigin(origin)
      check(preferences().edit().putString("origin", normalized).putString("appearance", appearance).commit()) { "Could not save receiver settings." }
    })
    AsyncFunction("viewer") Coroutine { -> withContext(Dispatchers.IO) { owner().viewer() } }
    AsyncFunction("prepare") { uri: String, name: String, endpoint: String -> owner().prepare(uri, name, endpoint) }
    AsyncFunction("cancel") { owner().cancel() }
    AsyncFunction("start", fun(): Unit {
      if (Build.VERSION.SDK_INT < 26) throw IllegalStateException("This spike requires Android 8 or newer.")
      check(appContext.currentActivity?.hasWindowFocus() == true) { "Return to Footage and tap Continue to schedule this user-initiated transfer." }
      val job = owner().store.current() ?: error("Prepare a video first.")
      check(job.phase !is Phase.Cancelled && job.phase !is Phase.Received) { "This transfer has ended." }
      val context = appContext.reactContext ?: error("Android context is unavailable.")
      if (Build.VERSION.SDK_INT >= 34) {
        val scheduler = context.getSystemService(JobScheduler::class.java)
        if (scheduler.getPendingJob(TransferJobService.JOB_ID) == null) {
          val network = NetworkRequest.Builder().addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET).build()
          val info = JobInfo.Builder(TransferJobService.JOB_ID, ComponentName(context, TransferJobService::class.java))
            .setUserInitiated(true).setRequiredNetwork(network).setEstimatedNetworkBytes(0, job.asset.bytes).build()
          check(scheduler.schedule(info) == JobScheduler.RESULT_SUCCESS) { "Android did not accept the transfer job." }
        }
      } else {
        context.startForegroundService(Intent(context, TransferForegroundService::class.java))
      }
    }).runOnQueue(Queues.MAIN)
  }

  private fun preferences() = (appContext.reactContext ?: error("Android context is unavailable."))
    .getSharedPreferences("footage-settings", Context.MODE_PRIVATE)

  private fun owner(): TransferOwner = TransferOwner.get(appContext.reactContext ?: error("Android context is unavailable."))
}
