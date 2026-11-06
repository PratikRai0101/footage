package expo.modules.footagetransfer

import android.app.Application
import android.app.job.JobScheduler
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Log
import io.tus.java.client.TusClient
import io.tus.java.client.TusUpload
import io.tus.java.client.ProtocolException
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

internal class ReceiverError(val status: Int, message: String) : IOException(message)

internal class TransferOwner private constructor(private val context: Application) {
  val store = TransferStore(context)
  private val worker = Executors.newSingleThreadExecutor()
  private val preparingCancelled = AtomicBoolean(false)
  private val running = AtomicBoolean(false)
  @Volatile private var preparation: Preparation? = null
  @Volatile private var preparationError: String? = null

  init { context.filesDir.listFiles()?.filter { it.name.endsWith(".partial") }?.forEach { it.delete() } }

  fun snapshot(): String {
    val staged = preparation
    if (staged != null) return JSONObject().put("kind", "preparing").put("name", staged.name).put("copiedBytes", staged.copied).toString()
    if (preparingCancelled.get()) return JSONObject().put("kind", "preparation_cancelled").toString()
    val failure = preparationError
    if (failure != null) return JSONObject().put("kind", "preparation_failed").put("message", failure).toString()
    return store.snapshot().put("executionActive", running.get()).toString()
  }

  @Synchronized fun prepare(source: String, name: String, endpoint: String) {
    require(preparation == null && !running.get()) { "A clip is already being prepared or transferred." }
    val existing = store.current()
    require(existing == null || existing.phase is Phase.Received || (existing.phase is Phase.Cancelled && !existing.phase.cleanupPending)) { "Finish or cancel the existing transfer first." }
    val origin = receiverOrigin(endpoint)
    val safeName = name.take(240).ifBlank { "Original video" }
    preparingCancelled.set(false)
    preparationError = null
    preparation = Preparation(safeName, 0)
    worker.execute {
      val id = UUID.randomUUID().toString()
      val partial = File(context.filesDir, "$id.partial")
      val destination = File(context.filesDir, "$id.original")
      try {
        val selected = Uri.parse(source)
        var expected: Long? = null
        context.contentResolver.query(selected, arrayOf(OpenableColumns.SIZE), null, null, null)?.use { cursor ->
          if (cursor.moveToFirst() && !cursor.isNull(0)) expected = cursor.getLong(0)
        }
        require(expected == null || expected!! <= MAX_BYTES) { "This spike accepts files up to 4 GiB." }
        require(expected == null || context.filesDir.usableSpace > expected!! + 8 * 1024 * 1024) { "Not enough storage for a stable local copy." }
        val hash = MessageDigest.getInstance("SHA-256")
        var count = 0L
        val input = context.contentResolver.openInputStream(selected) ?: error("The selected video is no longer accessible.")
        input.use { sourceStream ->
          FileOutputStream(partial).use { output ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
              if (preparingCancelled.get()) throw InterruptedException("Preparation cancelled.")
              val read = sourceStream.read(buffer)
              if (read < 0) break
              count += read
              require(count <= MAX_BYTES) { "This spike accepts files up to 4 GiB." }
              output.write(buffer, 0, read)
              hash.update(buffer, 0, read)
              preparation = Preparation(safeName, count)
            }
            output.fd.sync()
          }
        }
        require(count > 0 && (expected == null || count == expected)) { "The selected file changed or could not be copied completely." }
        if (preparingCancelled.get()) throw InterruptedException("Preparation cancelled.")
        check(partial.renameTo(destination)) { "Could not save the staged video." }
        val sha256 = hash.digest().joinToString("") { "%02x".format(it) }
        val asset = Asset(safeName, destination.absolutePath, count, sha256, VideoMetadata.inspect(context, Uri.fromFile(destination)))
        val capability = UUID.randomUUID().toString().replace("-", "") + UUID.randomUUID().toString().replace("-", "")
        synchronized(this) {
          if (preparingCancelled.get()) throw InterruptedException("Preparation cancelled.")
          store.replace(TransferJob(id, asset, origin, capability, Phase.Ready))
          preparation = null
        }
        existing?.let { File(it.asset.path).delete() }
      } catch (error: Exception) {
        partial.delete(); destination.delete()
        if (error !is InterruptedException) preparationError = error.message ?: "Could not prepare the video. Choose it again."
      } finally { preparation = null }
    }
  }

  @Synchronized fun cancel() {
    preparationError = null
    if (preparation != null) { preparingCancelled.set(true); return }
    val job = store.current() ?: return
    if (job.phase is Phase.Received) return
    store.update(job.id) { if (it.phase is Phase.Received) it else it.copy(phase = Phase.Cancelled(true)) }
    context.getSystemService(JobScheduler::class.java).cancel(TransferJobService.JOB_ID)
    context.stopService(Intent(context, TransferForegroundService::class.java))
    worker.execute { cleanup(job) }
  }

  private fun cleanup(job: TransferJob) {
    try {
      val result = request(job, "DELETE", "/jobs/${job.id}", allowConflict = true)
      if (result.has("receipt")) publishReceipt(job, result.getJSONObject("receipt"))
      else {
        store.update(job.id) { if (it.phase is Phase.Cancelled) it.copy(phase = Phase.Cancelled(false)) else it }
        File(job.asset.path).delete()
      }
    } catch (_: IOException) { /* The durable cancelled state retains cleanupPending until retry. */ }
  }

  fun run(stopped: AtomicBoolean, finished: () -> Unit) {
    if (!running.compareAndSet(false, true)) { finished(); return }
    worker.execute {
      try {
        var delay = 1_000L
        while (!stopped.get()) {
          val job = store.current() ?: break
          if (job.phase is Phase.Cancelled || job.phase is Phase.Received) break
          try {
            transfer(job, stopped)
            break
          } catch (error: Exception) {
            if (stopped.get() || store.current()?.phase is Phase.Cancelled) break
            val status = when (error) {
              is ReceiverError -> error.status
              is ProtocolException -> error.causingConnection?.responseCode
              else -> null
            }
            Log.i("FootageTransfer", JSONObject().put("event", "transfer_attempt_failed").put("jobId", job.id)
              .put("errorType", error.javaClass.simpleName).put("status", status ?: JSONObject.NULL)
              .put("confirmedBytes", store.current()?.confirmed ?: 0).toString())
            if (status == 507) {
              changePhase(job.id, Phase.Failed("The upload destination is full. Free up space or choose another destination in Settings, then try again.", false))
              break
            }
            if (status != null && status in 400..499 && status != 408 && status != 429) {
              changePhase(job.id, Phase.Failed(if (status == 404 || status == 410) "Upload expired or removed. Cancel, then choose the clip again." else error.message ?: "Server rejected the upload.", false))
              break
            }
            if (error !is IOException && error !is ProtocolException) {
              changePhase(job.id, Phase.Failed(error.message ?: "Transfer failed.", false)); break
            }
            changePhase(job.id, Phase.Waiting("Connection interrupted. Confirmed progress is saved; retrying."))
            var remaining = delay
            while (remaining > 0 && !stopped.get() && store.current()?.phase !is Phase.Cancelled) { Thread.sleep(250); remaining -= 250 }
            delay = minOf(delay * 2, 8_000)
          }
        }
      } finally { running.set(false); finished() }
    }
  }

  private fun transfer(job: TransferJob, stopped: AtomicBoolean) {
    fun active() = !stopped.get() && store.current()?.let { it.id == job.id && it.phase !is Phase.Cancelled } == true
    if (!active()) return
    val metadata = JSONObject().put("id", job.id).put("name", job.asset.name).put("bytes", job.asset.bytes).put("sha256", job.asset.sha256)
    val registration = request(job, "POST", "/jobs", metadata)
    if (registration.getString("status") == "received") { publishReceipt(job, registration.getJSONObject("receipt")); return }
    if (!active()) return
    val client = object : TusClient() {
      override fun prepareConnection(connection: HttpURLConnection) {
        super.prepareConnection(connection)
        connection.readTimeout = 20_000
        connection.instanceFollowRedirects = false
      }
    }
    client.setConnectTimeout(15_000)
    client.setHeaders(mapOf("Authorization" to "Bearer ${job.capability}"))
    val uploader = client.beginOrResumeUploadFromURL(TusUpload(File(job.asset.path)), URL("${job.endpoint}/files/${job.id}"))
    try {
      require(uploader.offset in 0..job.asset.bytes) { "Server returned an invalid upload offset." }
      confirmed(job.id, uploader.offset)
      changePhase(job.id, Phase.Uploading)
      uploader.setChunkSize(64 * 1024)
      uploader.setRequestPayloadSize(PAYLOAD_BYTES)
      var boundary = minOf(uploader.offset + PAYLOAD_BYTES, job.asset.bytes)
      while (uploader.offset < job.asset.bytes && active()) {
        check(uploader.uploadChunk() > 0) { "Staged video ended before the expected length." }
        if (uploader.offset >= boundary && uploader.offset < job.asset.bytes) {
          // A full request has returned a matching Upload-Offset, not merely written to the socket.
          confirmed(job.id, uploader.offset)
          boundary = minOf(uploader.offset + PAYLOAD_BYTES, job.asset.bytes)
        }
      }
      uploader.finish()
      if (!active()) return
      confirmed(job.id, uploader.offset)
    } finally {
      // finish also closes the native input. Errors here cannot create success or advance confirmed bytes.
      try { uploader.finish() } catch (_: Exception) { }
    }
    if (!active()) return
    changePhase(job.id, Phase.Verifying)
    publishReceipt(job, request(job, "POST", "/jobs/${job.id}/complete"))
  }

  fun viewer(): String {
    val job = store.current() ?: error("There is no received original.")
    check(job.phase is Phase.Received) { "Wait for the verified receipt before opening the received file." }
    val path = request(job, "POST", "/jobs/${job.id}/view").getString("path")
    check(Regex("^/receive#[a-f0-9]{64}$").matches(path)) { "The receiver returned an invalid viewing link." }
    return job.endpoint + path
  }

  private fun confirmed(id: String, bytes: Long) { store.update(id) { if (it.phase is Phase.Cancelled || it.phase is Phase.Received) it else it.copy(confirmed = bytes) } }
  private fun changePhase(id: String, phase: Phase) { store.update(id) { if (it.phase is Phase.Cancelled || it.phase is Phase.Received) it else it.copy(phase = phase) } }

  private fun publishReceipt(job: TransferJob, receipt: JSONObject) {
    require(receipt.getString("jobId") == job.id && receipt.getLong("bytes") == job.asset.bytes && receipt.getString("sha256") == job.asset.sha256) { "The receipt does not match this original." }
    UUID.fromString(receipt.getString("id"))
    store.update(job.id) { it.copy(phase = Phase.Received(receipt), confirmed = job.asset.bytes) }
  }

  private fun request(job: TransferJob, method: String, path: String, body: JSONObject? = null, allowConflict: Boolean = false): JSONObject {
    val connection = URL(job.endpoint + path).openConnection()
    require(connection is HttpURLConnection) { "Only HTTP demo endpoints are supported." }
    try {
      connection.requestMethod = method
      connection.connectTimeout = 15_000; connection.readTimeout = 30_000
      connection.instanceFollowRedirects = false
      connection.setRequestProperty("Authorization", "Bearer ${job.capability}")
      if (body != null) {
        connection.doOutput = true
        connection.setRequestProperty("Content-Type", "application/json")
        connection.outputStream.use { it.write(body.toString().toByteArray()) }
      }
      val code = connection.responseCode
      val input = if (code in 200..299) connection.inputStream else connection.errorStream
      val bytes = input?.use { stream ->
        val buffer = ByteArray(64 * 1024 + 1)
        var count = 0
        while (count < buffer.size) {
          val read = stream.read(buffer, count, buffer.size - count)
          if (read < 0) break
          count += read
        }
        require(count <= 64 * 1024) { "Server response exceeded the metadata limit." }
        buffer.copyOf(count)
      } ?: ByteArray(0)
      val response = if (bytes.isEmpty()) JSONObject() else JSONObject(String(bytes, Charsets.UTF_8))
      if (code !in 200..299 && !(allowConflict && code == 409 && response.has("receipt"))) throw ReceiverError(code, response.optString("error", "Server request failed ($code)."))
      return response
    } finally { connection.disconnect() }
  }

  companion object {
    private const val MAX_BYTES = 4L * 1024 * 1024 * 1024
    private const val PAYLOAD_BYTES = 2 * 1024 * 1024
    @Volatile private var instance: TransferOwner? = null
    @Synchronized fun get(context: Context): TransferOwner {
      val application = context.applicationContext
      require(application is Application) { "An application context is required." }
      return instance ?: TransferOwner(application).also { instance = it }
    }
  }
}
