package expo.modules.footagetransfer

import android.content.Context
import android.net.Uri
import android.util.AtomicFile
import org.json.JSONObject
import java.io.File

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
internal data class TransferJob(
  val id: String, val asset: Asset, val endpoint: String, val capability: String,
  val phase: Phase, val confirmed: Long = 0,
)
internal data class Preparation(val name: String, val copied: Long)

internal class TransferStore(context: Context) {
  private val file = AtomicFile(File(context.filesDir, "transfer.json"))
  private var job: TransferJob? = if (file.baseFile.exists()) decode(JSONObject(file.readFully().toString(Charsets.UTF_8))) else null

  @Synchronized fun current(): TransferJob? = job

  @Synchronized fun replace(value: TransferJob) {
    val output = file.startWrite()
    try { output.write(encode(value).toString().toByteArray()); file.finishWrite(output); job = value }
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
      .put("capability", value.capability).put("confirmed", value.confirmed).put("phase", phase).put("media", value.asset.media.json())
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
    return TransferJob(json.getString("id"), asset, json.getString("endpoint"), json.getString("capability"), state, json.getLong("confirmed"))
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
