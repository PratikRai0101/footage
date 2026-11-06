package expo.modules.footagetransfer

import android.content.Context
import android.media.MediaMetadataRetriever
import android.net.Uri
import org.json.JSONObject

internal data class VideoMetadata(
  val durationMs: Long? = null,
  val width: Int? = null,
  val height: Int? = null,
  val mimeType: String? = null,
) {
  fun json(): JSONObject = JSONObject()
    .put("durationMs", durationMs ?: JSONObject.NULL)
    .put("width", width ?: JSONObject.NULL)
    .put("height", height ?: JSONObject.NULL)
    .put("mimeType", mimeType ?: JSONObject.NULL)

  companion object {
    fun decode(value: JSONObject?): VideoMetadata = if (value == null) VideoMetadata() else VideoMetadata(
      value.optLong("durationMs").takeIf { it > 0 }, value.optInt("width").takeIf { it > 0 },
      value.optInt("height").takeIf { it > 0 }, value.optString("mimeType").takeIf { !value.isNull("mimeType") && it.isNotBlank() },
    )

    fun inspect(context: Context, uri: Uri): VideoMetadata {
      val retriever = MediaMetadataRetriever()
      return try {
        retriever.setDataSource(context, uri)
        val width = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull()?.takeIf { it > 0 }
        val height = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull()?.takeIf { it > 0 }
        val rotation = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull()
        VideoMetadata(
          retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull()?.takeIf { it > 0 },
          if (rotation == 90 || rotation == 270) height else width,
          if (rotation == 90 || rotation == 270) width else height,
          retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_MIMETYPE),
        )
      } catch (_: Exception) {
        // Unsupported inspection is not permission to transcode or reject original bytes.
        VideoMetadata()
      } finally {
        try { retriever.release() } catch (_: RuntimeException) { /* Optional inspection must not reject original bytes. */ }
      }
    }
  }
}
