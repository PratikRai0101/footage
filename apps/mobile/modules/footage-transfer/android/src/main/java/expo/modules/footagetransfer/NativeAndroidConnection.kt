package expo.modules.footagetransfer

import android.app.Activity
import android.app.AlertDialog
import android.net.Uri
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.IOException
import java.util.UUID
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

internal object NativeAndroidConnection {
  private suspend fun choose(activity: Activity, heading: String, detail: String, titles: List<String>): Int = withContext(Dispatchers.Main) {
    suspendCancellableCoroutine { continuation ->
      val dialog = AlertDialog.Builder(activity).setTitle(heading).setMessage(detail)
        .setNegativeButton("Cancel") { _, _ -> if (continuation.isActive) continuation.resumeWithException(IOException("Cancelled. Nothing was sent.")) }
        .create()
      // AlertDialog does not display both message and a list. Explicit destination
      // buttons follow a separate confirmation containing the exact trust origin.
      dialog.setButton(AlertDialog.BUTTON_POSITIVE, "Continue") { _, _ ->
        if (continuation.isActive) {
          AlertDialog.Builder(activity).setTitle(heading).setItems(titles.toTypedArray()) { _, index -> if (continuation.isActive) continuation.resume(index) }
            .setNegativeButton("Cancel") { _, _ -> if (continuation.isActive) continuation.resumeWithException(IOException("Cancelled. Nothing was sent.")) }
            .setOnCancelListener { if (continuation.isActive) continuation.resumeWithException(IOException("Cancelled. Nothing was sent.")) }.show()
        }
      }
      dialog.setOnCancelListener { if (continuation.isActive) continuation.resumeWithException(IOException("Cancelled. Nothing was sent.")) }
      dialog.show(); continuation.invokeOnCancellation { activity.runOnUiThread { dialog.dismiss() } }
    }
  }
  private fun title(value: String): String {
    check(value.isNotEmpty() && value.toByteArray().size <= 120 && value.none { Character.isISOControl(it) }); return value
  }
  suspend fun connect(activity: Activity, owner: TransferOwner, uri: String): String {
    check(owner.canChangeConnection()) { "Finish or cancel the current upload first." }
    val bytes = withContext(Dispatchers.IO) {
      val source = activity.contentResolver.openInputStream(Uri.parse(uri)) ?: error("Choose the private connection file.")
      source.use { val out = java.io.ByteArrayOutputStream(); val buffer = ByteArray(1024); while (true) { val n = it.read(buffer); if (n < 0) break; check(out.size() + n <= 8192); out.write(buffer, 0, n) }; out.toByteArray() }
    }
    val file = JSONObject(bytes.toString(Charsets.UTF_8)); check(file.getString("format") == "footage-connection-v1")
    val offer = PairingOffer(android.util.Base64.decode(file.getString("offer"), android.util.Base64.NO_WRAP))
    val destinations = file.getJSONArray("destinations"); check(destinations.length() in 1..16)
    val labels = (0 until destinations.length()).map { title(destinations.getJSONObject(it).getString("title")) }
    val selected = choose(activity, "Connect computer", "${offer.origin.text}\n\nOnly open a private connection file obtained directly from your computer. Choose the destination for your originals.", labels)
    return withContext(Dispatchers.IO) {
      check(owner.canChangeConnection())
      val client = owner.paired.client
      client.replaceAfterNativeConfirmation(offer.bytes, offer.mask)
      try { client.enroll() } catch (_: Exception) { client.recoverLostReply() }
      save(owner, destinations.getJSONObject(selected).getString("id"), labels[selected])
    }
  }
  private fun save(owner: TransferOwner, intake: String, title: String): String {
    UUID.fromString(intake); val identity = owner.paired.client.nativeIdentity()
    val profile = JSONObject().put("origin", identity.origin).put("title", title).put("intake", intake).put("receiver", sealedHex(identity.receiver)).put("device", sealedHex(identity.device))
    owner.paired.saveConnection(profile)
    return JSONObject().put("origin", identity.origin).put("title", title).toString()
  }
  suspend fun select(activity: Activity, owner: TransferOwner): String {
    check(owner.canChangeConnection()) { "Finish or cancel the current upload first." }
    val listing = withContext(Dispatchers.IO) { JSONObject(owner.paired.client.listDestinations().toString(Charsets.UTF_8)) }
    check(listing.getInt("version") == 1); val rows = listing.getJSONArray("destinations"); check(rows.length() in 1..16)
    val labels = (0 until rows.length()).map { title(rows.getJSONObject(it).getString("title")) }
    val selected = choose(activity, "Choose destination", "Applies to your next original. Existing uploads keep their confirmed destination.", labels)
    return withContext(Dispatchers.IO) { check(owner.canChangeConnection()); save(owner, rows.getJSONObject(selected).getString("id"), labels[selected]) }
  }
  suspend fun handoff(activity: Activity, owner: TransferOwner, operation: String): String {
    val job = owner.store.current() ?: error("Choose a verified original.")
    check(job.transport == TransferProtocol.Sealed && job.phase is Phase.Received)
    withContext(Dispatchers.IO) { owner.paired.verifyReceived(job) }
    val op = when (operation) { "status" -> 0; "deliver" -> 1; "send" -> 2; else -> error("Unknown handoff.") }
    if (op == 2) {
      val destination = owner.paired.destinationTitle(job)
      choose(activity, "Send verified original?", "$destination\n\nStarts or queues T3 agent work in this exact destination. Does not authorize paid generation.", listOf("Send to thread"))
    }
    check(owner.store.current()?.id == job.id) { "The selected original changed. Nothing was sent." }
    return withContext(Dispatchers.IO) { owner.paired.handoff(job, op) }
  }
}
