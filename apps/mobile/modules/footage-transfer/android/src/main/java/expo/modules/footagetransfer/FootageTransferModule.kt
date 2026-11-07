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
    AsyncFunction("connection") {
      val value = owner().paired.connection()
      if (value == null) "null" else JSONObject().put("origin", value.getString("origin")).put("title", value.getString("title")).toString()
    }
    AsyncFunction("connect") Coroutine { uri: String ->
      try { NativeAndroidConnection.connect(appContext.currentActivity ?: error("Return to Footage first."), owner(), uri) }
      catch (_: Exception) { throw IllegalStateException("Connection not completed. Check the private file and approve this phone on your computer.") }
    }
    AsyncFunction("selectDestination") Coroutine { -> NativeAndroidConnection.select(appContext.currentActivity ?: error("Return to Footage first."), owner()) }
    AsyncFunction("handoff") Coroutine { operation: String -> NativeAndroidConnection.handoff(appContext.currentActivity ?: error("Return to Footage first."), owner(), operation) }
    AsyncFunction("inspect") Coroutine { source: String ->
      withContext(Dispatchers.IO) {
        VideoMetadata.inspect(appContext.reactContext ?: error("Android context is unavailable."), Uri.parse(source)).json().toString()
      }
    }
    AsyncFunction("settings") {
      val preferences = preferences()
      JSONObject().put("origin", owner().paired.connection()?.getString("origin") ?: preferences.getString("origin", ""))
        .put("appearance", preferences.getString("appearance", "dark")).toString()
    }
    AsyncFunction("configure", fun(origin: String, appearance: String): Unit {
      require(appearance in listOf("dark", "light", "system")) { "Choose a supported appearance." }
      val paired = owner().paired.connection()
      val normalized = if (paired != null) { check(origin == paired.getString("origin")) { "Use Change connection; a paired upload never falls back to an address." }; origin } else if (origin.isBlank()) "" else receiverOrigin(origin)
      check(preferences().edit().putString("origin", normalized).putString("appearance", appearance).commit()) { "Could not save receiver settings." }
    })
    AsyncFunction("openViewer") Coroutine { ->
      val context = appContext.reactContext ?: error("Android context unavailable.")
      val job = owner().store.current() ?: error("Open a verified original first.")
      check(job.transport == TransferProtocol.Sealed)
      val file = withContext(Dispatchers.IO) { owner().paired.receivedCopy(job) }
      withContext(Dispatchers.Main) { context.startActivity(Intent(context, ReceivedOriginalActivity::class.java).putExtra("path", file.absolutePath).putExtra("name", job.asset.name).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
    }
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
