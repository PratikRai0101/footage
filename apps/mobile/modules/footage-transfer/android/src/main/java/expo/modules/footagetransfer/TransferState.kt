package expo.modules.footagetransfer

import android.content.Context
import android.net.Uri
import android.util.AtomicFile
import org.json.JSONObject
import java.io.File
import java.util.UUID

internal data class Asset(val name: String, val path: String, val bytes: Long, val sha256: String, val media: VideoMetadata = VideoMetadata())
internal sealed interface Phase {
  data object Ready : Phase
  data object Uploading : Phase
  data class Waiting(val reason: String) : Phase
  data object Verifying : Phase
  data class Received(val receipt: JSONObject) : Phase
  data class Cancelled(val cleanupPending: Boolean) : Phase
  data class Failed(val reason: String, val retryable: Boolean) : Phase
}
internal enum class TransferProtocol { Legacy, Sealed }
internal data class TransferJob(
  val id: String, val asset: Asset, val endpoint: String, val capability: String,
  val phase: Phase, val confirmed: Long = 0, val transport: TransferProtocol = TransferProtocol.Legacy,
)
internal data class Preparation(val name: String, val copied: Long)

internal class TransferStore(private val context: Context) {
  private val file = AtomicFile(File(context.filesDir, "transfer.json"))
  private var job: TransferJob? = if (file.baseFile.exists() || File(file.baseFile.path + ".bak").exists()) {
    val bytes = file.openRead().use { input ->
      val bounded = ByteArray(65537); var count = 0
      while (count < bounded.size) { val n = input.read(bounded, count, bounded.size - count); if (n < 0) break; check(n > 0); count += n }
      check(count <= 65536); bounded.copyOf(count)
    }
    decode(JSONObject(bytes.toString(Charsets.UTF_8)))
  } else {
    check(File(context.noBackupFilesDir, "pairing-v1").listFiles()?.none { it.name.startsWith("data-sealed-") } != false) { "Saved paired transfer state is missing. Do not reset its authority." }
    null
  }
  private fun syncDirectory(directory: File) {
    val fd = android.system.Os.open(directory.absolutePath, android.system.OsConstants.O_RDONLY, 0)
    try { android.system.Os.fsync(fd) } finally { android.system.Os.close(fd) }
  }

  @Synchronized fun current(): TransferJob? = job

  @Synchronized fun replace(value: TransferJob) {
    val previous = job
    if (previous != null && previous.id != value.id) {
      check(previous.phase is Phase.Received || previous.phase is Phase.Cancelled && !previous.phase.cleanupPending)
      val history = File(context.noBackupFilesDir, "original-history").apply { check(isDirectory || mkdirs()) }
      val archive = AtomicFile(File(history, "${UUID.fromString(previous.id)}.json"))
      val saved = archive.startWrite()
      try { saved.write(encode(previous).toString().toByteArray()); saved.fd.sync(); archive.finishWrite(saved); syncDirectory(history); syncDirectory(context.noBackupFilesDir) } catch (error: Exception) { archive.failWrite(saved); throw error }
    }
    val output = file.startWrite()
    try { android.system.Os.fchmod(output.fd, 384); output.write(encode(value).toString().toByteArray()); output.fd.sync(); file.finishWrite(output); syncDirectory(context.filesDir); job = value }
    catch (error: Exception) { file.failWrite(output); throw error }
  }

  @Synchronized fun update(id: String, change: (TransferJob) -> TransferJob): TransferJob? {
    val before = job ?: return null
    if (before.id != id) return null
    val after = change(before)
    replace(after)
    return after
  }

  private fun encode(value: TransferJob): JSONObject {
    val phase = when (val state = value.phase) {
      Phase.Ready -> JSONObject().put("kind", "ready")
      Phase.Uploading -> JSONObject().put("kind", "uploading")
      is Phase.Waiting -> JSONObject().put("kind", "waiting").put("reason", state.reason)
      Phase.Verifying -> JSONObject().put("kind", "verifying")
      is Phase.Received -> JSONObject().put("kind", "received").put("receipt", state.receipt)
      is Phase.Cancelled -> JSONObject().put("kind", "cancelled").put("cleanupPending", state.cleanupPending)
      is Phase.Failed -> JSONObject().put("kind", "failed").put("reason", state.reason).put("retryable", state.retryable)
    }
    return JSONObject().put("id", value.id).put("name", value.asset.name).put("path", value.asset.path)
      .put("bytes", value.asset.bytes).put("sha256", value.asset.sha256).put("endpoint", value.endpoint)
      .put("capability", value.capability).put("protocol", value.transport.name).put("confirmed", value.confirmed).put("phase", phase).put("media", value.asset.media.json())
  }

  private fun decode(json: JSONObject): TransferJob {
    val phase = json.getJSONObject("phase")
    val state = when (phase.getString("kind")) {
      "ready" -> Phase.Ready
      "uploading" -> Phase.Uploading
      "waiting" -> Phase.Waiting(phase.getString("reason"))
      "verifying" -> Phase.Verifying
      "received" -> Phase.Received(phase.getJSONObject("receipt"))
      "cancelled" -> Phase.Cancelled(phase.getBoolean("cleanupPending"))
      "failed" -> Phase.Failed(phase.getString("reason"), phase.getBoolean("retryable"))
      else -> error("Unknown durable transfer state. Do not silently discard the existing job.")
    }
    val asset = Asset(json.getString("name"), json.getString("path"), json.getLong("bytes"), json.getString("sha256"), VideoMetadata.decode(json.optJSONObject("media")))
    require(asset.bytes > 0 && asset.sha256.matches(Regex("[a-f0-9]{64}")))
    return TransferJob(json.getString("id"), asset, json.getString("endpoint"), json.getString("capability"), state, json.getLong("confirmed"), if (json.has("protocol")) TransferProtocol.valueOf(json.getString("protocol")) else TransferProtocol.Legacy)
  }

  fun snapshot(): JSONObject {
    val value = current() ?: return JSONObject().put("kind", "empty")
    val output = JSONObject().put("id", value.id).put("name", value.asset.name).put("bytes", value.asset.bytes)
      .put("confirmedBytes", value.confirmed).put("sha256", value.asset.sha256)
      .put("localUri", if (File(value.asset.path).exists()) Uri.fromFile(File(value.asset.path)).toString() else JSONObject.NULL)
      .put("media", value.asset.media.json())
    when (val phase = value.phase) {
      Phase.Ready -> output.put("kind", "ready")
      Phase.Uploading -> output.put("kind", "uploading")
      is Phase.Waiting -> output.put("kind", "waiting").put("message", phase.reason)
      Phase.Verifying -> output.put("kind", "verifying")
      is Phase.Received -> output.put("kind", "received").put("receipt", phase.receipt)
      is Phase.Cancelled -> output.put("kind", "cancelled").put("cleanupPending", phase.cleanupPending)
      is Phase.Failed -> output.put("kind", "failed").put("message", phase.reason).put("retryable", phase.retryable)
    }
    return output
  }
}
