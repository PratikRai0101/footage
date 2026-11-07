package expo.modules.footagetransfer

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.MediaController
import android.widget.TextView
import android.widget.VideoView
import androidx.core.content.FileProvider
import java.io.File

/** Only opens an independently hash-verified receiver download. No TLS bypass,
 * global CA installation, writable browser session or upload capability. */
class ReceivedOriginalActivity : Activity() {
  private var video: VideoView? = null
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val path = intent.getStringExtra("path") ?: return finish()
    val file = File(path).canonicalFile; val root = File(cacheDir, "received-viewer").canonicalFile
    if (file.parentFile != root || !file.isFile) return finish()
    val padding = (16 * resources.displayMetrics.density).toInt()
    val layout = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(padding, padding, padding, padding); setBackgroundColor(Color.rgb(27, 26, 24)) }
    layout.setOnApplyWindowInsetsListener { view, insets ->
      if (android.os.Build.VERSION.SDK_INT >= 30) {
        val bars = insets.getInsets(android.view.WindowInsets.Type.systemBars()); view.setPadding(padding + bars.left, padding + bars.top, padding + bars.right, padding + bars.bottom)
      } else { view.setPadding(padding + insets.systemWindowInsetLeft, padding + insets.systemWindowInsetTop, padding + insets.systemWindowInsetRight, padding + insets.systemWindowInsetBottom) }
      insets
    }
    fun text(value: String, size: Float) = TextView(this).apply { text = value; importantForAccessibility = android.view.View.IMPORTANT_FOR_ACCESSIBILITY_YES; textSize = size; setTextColor(Color.rgb(244, 241, 233)); setPadding(0, 12, 0, 12) }
    layout.addView(Button(this).apply { text = "Close"; isAllCaps = false; setOnClickListener { finish() } })
    layout.addView(text("Received & verified", 24f))
    layout.addView(text(intent.getStringExtra("name") ?: "Original", 16f))
    layout.addView(text("Original bytes downloaded from your paired computer and SHA-256 checked. Cached for local playback.", 14f))
    video = VideoView(this).also { player ->
      player.contentDescription = "Verified received original video"; player.setMediaController(MediaController(this)); player.setVideoURI(Uri.fromFile(file))
      player.setOnPreparedListener { player.start() }
      player.setOnErrorListener { _, _, _ -> layout.addView(text("This device cannot preview this codec. The verified original can still be shared.", 14f)); true }
      layout.addView(player, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
    }
    layout.addView(Button(this).apply {
      text = "Share original"; isAllCaps = false
      setOnClickListener {
        val uri = FileProvider.getUriForFile(this@ReceivedOriginalActivity, "$packageName.footage.originals", file)
        startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).apply { type = "video/*"; putExtra(Intent.EXTRA_STREAM, uri); addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION) }, "Share verified original"))
      }
    })
    setContentView(layout)
  }
  override fun onPause() { video?.pause(); super.onPause() }
  override fun onDestroy() { video?.stopPlayback(); super.onDestroy() }
}
