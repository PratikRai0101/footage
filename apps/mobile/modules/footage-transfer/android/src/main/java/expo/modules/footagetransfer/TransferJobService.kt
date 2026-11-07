package expo.modules.footagetransfer

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.job.JobParameters
import android.app.job.JobService
import android.os.Build
import java.util.concurrent.atomic.AtomicBoolean

class TransferJobService : JobService() {
  private data class Execution(val stopped: AtomicBoolean, val job: String)
  private val executions = java.util.concurrent.ConcurrentHashMap<JobParameters, Execution>()

  override fun onStartJob(params: JobParameters): Boolean {
    if (Build.VERSION.SDK_INT < 34) return false
    val owner = TransferOwner.get(this)
    val job = owner.store.current() ?: return false
    val execution = Execution(AtomicBoolean(false), job.id)
    executions[params] = execution
    val currentStop = execution.stopped
    val manager = getSystemService(NotificationManager::class.java)
    manager.createNotificationChannel(NotificationChannel(CHANNEL, "Original video transfer", NotificationManager.IMPORTANCE_LOW))
    val intent = packageManager.getLaunchIntentForPackage(packageName)
    val notification = Notification.Builder(this, CHANNEL)
      .setSmallIcon(android.R.drawable.stat_sys_upload)
      .setContentTitle("Footage original transfer")
      .setContentText("Sending your original. Open Footage for server-confirmed progress.")
      .setOngoing(true)
    if (intent != null) notification.setContentIntent(PendingIntent.getActivity(this, 0, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
    setNotification(params, JOB_ID, notification.build(), JOB_END_NOTIFICATION_POLICY_REMOVE)
    owner.run(currentStop) {
      executions.remove(params, execution)
      if (!currentStop.get()) jobFinished(params, false)
    }
    return true
  }

  override fun onStopJob(params: JobParameters): Boolean {
    val execution = executions.remove(params) ?: return false
    execution.stopped.set(true)
    val owner = TransferOwner.get(this)
    owner.paired.stop(execution.job)
    val job = owner.store.current()?.takeIf { it.id == execution.job } ?: return false
    owner.store.update(job.id) {
      if (it.phase is Phase.Cancelled || it.phase is Phase.Received || it.phase is Phase.Failed) it
      else it.copy(phase = Phase.Waiting("Android interrupted the job. Reopen to reconcile and continue."))
    }
    return job.phase !is Phase.Cancelled && job.phase !is Phase.Received && job.phase !is Phase.Failed
  }

  companion object {
    const val JOB_ID = 14271
    private const val CHANNEL = "footage-transfer"
  }
}
