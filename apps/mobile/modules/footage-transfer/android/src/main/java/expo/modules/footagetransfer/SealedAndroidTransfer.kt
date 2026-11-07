package expo.modules.footagetransfer

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import java.text.Normalizer
import java.time.Instant

/** Adapter for the existing native service/job owner, not a second scheduler. */
internal class SealedAndroidTransfer(private val context: Context, private val store: TransferStore) {
  val vault = PairingAndroidVault(context)
  val client = PairingClient(vault)
  private data class SocketOwner(val job: String, val socket: javax.net.ssl.SSLSocket)
  private val socket = java.util.concurrent.atomic.AtomicReference<SocketOwner?>()
  fun stop(job: String) {
    while (true) {
      val current = socket.get() ?: return
      if (current.job != job) return
      if (socket.compareAndSet(current, null)) { try { current.socket.close() } catch (_: IOException) {}; return }
    }
  }
  private val directory = File(context.noBackupFilesDir, "sealed-originals").apply { check(isDirectory || mkdirs()) }
  fun connection(): JSONObject? {
    val saved = vault.readBlob("connection")
    if (saved == null) { check(vault.read() == null) { "Complete or recover the saved computer connection first." }; return null }
    return JSONObject(saved.toString(Charsets.UTF_8))
  }
  fun saveConnection(value: JSONObject) = vault.saveBlob("connection", value.toString().toByteArray())
  fun ownsJob(id: String): Boolean = vault.readBlob("sealed-$id") != null
  private fun state(id: String): JSONObject = JSONObject(requireNotNull(vault.readBlob("sealed-$id")) { "Saved paired upload unavailable; do not replace it." }.toString(Charsets.UTF_8))
  private fun save(id: String, value: JSONObject) = vault.saveBlob("sealed-$id", value.toString().toByteArray())
  private fun manifest(value: JSONObject) = SealedManifest(android.util.Base64.decode(value.getString("manifest"), android.util.Base64.NO_WRAP))
  private fun bound(job: TransferJob, value: JSONObject): SealedManifest {
    val manifest = manifest(value)
    check(job.asset.path == File(context.filesDir, "${job.id}.original").absolutePath && sealedUUID(manifest.job) == job.id && manifest.origin == job.endpoint && manifest.originalBytes == job.asset.bytes && sealedHex(manifest.originalHash) == job.asset.sha256 && manifest.name == job.asset.name) { "Saved original binding is damaged." }
    return manifest
  }
  fun recoverCompleted(job: TransferJob) {
    val value = state(job.id); val manifest = bound(job, value)
    if (job.phase is Phase.Received) { verifyReceived(job); return }
    if (value.has("receipt")) {
      check(!value.isNull("master"))
      val keys = SealedKeys(manifest, sealedUnhex(value.getString("master")))
      received(job, keys, keys.receipt(android.util.Base64.decode(value.getString("receipt"), android.util.Base64.NO_WRAP)))
    }
  }
  fun decorate(job: TransferJob, snapshot: JSONObject) {
    val value = state(job.id); val manifest = bound(job, value)
    snapshot.put("destinationTitle", value.getString("title"))
    if (job.phase !is Phase.Cancelled) snapshot.put("confirmedBytes", manifest.contiguous(value.getString("bitmap").toULong()))
  }
  private fun group(id: String, index: Int) = File(directory, "$id-$index.sealed")
  private fun keys(id: String, value: JSONObject): SealedKeys {
    val manifest = manifest(value)
    if (value.isNull("master")) {
      value.put("setupAttempted", true); save(id, value)
      val reply = client.control(PairingControlOperation.SETUP, manifest.job, manifest.bytes)
      val r = PairingReader(reply, "FTSET001", 80); pairingCheck(r.take(32).contentEquals(manifest.digest))
      val master = r.take(32); pairingCheck(r.u64() == manifest.expires); r.end()
      value.put("master", sealedHex(master)); save(id, value)
    }
    return SealedKeys(manifest, sealedUnhex(value.getString("master")))
  }
  fun prepare(id: String, asset: Asset, origin: String, active: () -> Boolean, publish: (() -> Unit) -> Unit) {
    val profile = requireNotNull(connection()); check(profile.getString("origin") == origin)
    val identity = client.nativeIdentity(); pairingCheck(identity.origin == origin && sealedHex(identity.receiver) == profile.getString("receiver") && sealedHex(identity.device) == profile.getString("device"))
    val frames = mutableListOf<ByteArray>(); val buffer = ByteArray(SealedManifest.FRAME)
    File(asset.path).inputStream().use { input ->
      var total = 0L
      while (total < asset.bytes) {
        if (!active()) throw InterruptedException("Preparation cancelled.")
        val expected = minOf(buffer.size.toLong(), asset.bytes - total).toInt(); var n = 0
        while (n < expected) { val read = input.read(buffer, n, expected - n); check(read > 0); n += read }
        frames.add(MessageDigest.getInstance("SHA-256").apply { update(buffer, 0, expected) }.digest()); total += expected
      }
      check(input.read() == -1)
    }
    val manifest = SealedManifest.create(identity, sealedUUID(profile.getString("intake")), sealedUUID(id), pairingRandom(16), asset.bytes, sealedUnhex(asset.sha256), Normalizer.normalize(asset.name, Normalizer.Form.NFC), minOf(identity.expires, (System.currentTimeMillis() / 1000).toULong() + 6u * 86400u), frames)
    val value = JSONObject().put("title", profile.getString("title")).put("manifest", android.util.Base64.encodeToString(manifest.bytes, android.util.Base64.NO_WRAP)).put("master", JSONObject.NULL).put("setupAttempted", false).put("revision", "0").put("bitmap", "0").put("intents", JSONArray()).put("wire", JSONArray()).put("prepared", false)
    publish {
      save(id, value)
      client.confirmStandaloneAfterNativeConfirmation(manifest.binding())
      store.replace(TransferJob(id, asset, origin, "", Phase.Failed("Preparation was interrupted. Cancel this upload before choosing another original.", false), transport = TransferProtocol.Sealed))
    }
    if (!active()) throw InterruptedException("Preparation cancelled.")
    val keys = keys(id, value)
    for (g in 0 until manifest.groups) {
      if (!active()) throw InterruptedException("Preparation cancelled.")
      val file = group(id, g); check(file.createNewFile()) { "Sealed files cannot be replaced." }
      val hash = keys.sealGroup(File(asset.path), file, g) { frame, seal ->
        if (!active()) throw InterruptedException("Preparation cancelled.")
        val intents = value.getJSONArray("intents"); check(intents.length() == frame)
        intents.put(sealedHex(seal)); save(id, value)
      }
      value.getJSONArray("wire").put(sealedHex(hash)); save(id, value)
    }
    value.put("prepared", true); save(id, value)
  }
  fun run(job: TransferJob, active: () -> Boolean) {
    val value = state(job.id); bound(job, value); check(value.getBoolean("prepared")) { "Cancel this interrupted preparation before choosing another original." }
    val keys = keys(job.id, value); reconcile(job, value, keys, false)
    if (!active() || store.current()?.phase is Phase.Received) return
    for (g in 0 until keys.manifest.groups) {
      if (!active()) return
      val bit = 1uL shl g
      if (value.getString("bitmap").toULong() and bit != 0uL) continue
      val file = group(job.id, g); val wire = sealedUnhex(value.getJSONArray("wire").getString(g))
      val actual = MessageDigest.getInstance("SHA-256"); file.inputStream().use { input -> val buffer = ByteArray(65536); while (true) { val n = input.read(buffer); if (n < 0) break; actual.update(buffer, 0, n) } }
      check(MessageDigest.isEqual(actual.digest(), wire)) { "Saved ciphertext is damaged; it cannot be regenerated." }
      store.update(job.id) { if (it.phase is Phase.Cancelled) it else it.copy(phase = Phase.Uploading) }
      val reply = client.sendGroup(keys.manifest.job, file, active) { connection ->
        if (connection == null) socket.updateAndGet { if (it?.job == job.id) null else it }
        else socket.set(SocketOwner(job.id, connection))
      }
      val result = keys.outcome(reply, g, wire, value.getString("revision").toULong())
      value.put("revision", result.first.toString()).put("bitmap", (value.getString("bitmap").toULong() or bit).toString()); save(job.id, value)
      store.update(job.id) { if (it.phase is Phase.Cancelled) it else it.copy(confirmed = keys.manifest.contiguous(value.getString("bitmap").toULong())) }
      if (result.second != null) { received(job, keys, result.second!!); return }
    }
    while (active() && store.current()?.phase !is Phase.Received) {
      store.update(job.id) { if (it.phase is Phase.Cancelled) it else it.copy(phase = Phase.Verifying) }
      reconcile(job, value, keys, false)
      if (store.current()?.phase !is Phase.Received) Thread.sleep(1000)
    }
  }
  private fun received(job: TransferJob, keys: SealedKeys, receipt: SealedReceipt) {
    val durable = state(job.id); bound(job, durable)
    durable.put("bitmap", ((1uL shl keys.manifest.groups) - 1uL).toString()).put("revision", maxOf(durable.getString("revision").toULong(), receipt.revision).toString()).put("receipt", android.util.Base64.encodeToString(receipt.envelope, android.util.Base64.NO_WRAP)); save(job.id, durable)
    val payload = JSONObject().put("id", receipt.id).put("jobId", job.id).put("bytes", keys.manifest.originalBytes).put("sha256", sealedHex(keys.manifest.originalHash)).put("verifiedAt", Instant.ofEpochSecond(receipt.verifiedAt.toLong()).toString())
    store.update(job.id) { it.copy(phase = Phase.Received(payload), confirmed = it.asset.bytes) }
  }
  private fun reconcile(job: TransferJob, value: JSONObject, keys: SealedKeys, revoke: Boolean) {
    val query = keys.query(); val status = keys.status(client.control(if (revoke) PairingControlOperation.REVOKE else PairingControlOperation.STATUS, keys.manifest.job, query), query, value.getString("revision").toULong())
    val before = value.getString("bitmap").toULong(); check(status.state >= 4 || (status.bitmap and before) == before) { "Receiver progress rolled back." }
    value.put("revision", status.revision.toString()).put("bitmap", status.bitmap.toString()); save(job.id, value)
    if (status.receipt != null) { received(job, keys, status.receipt); return }
    if (status.state >= 4) {
      store.update(job.id) { if (it.phase is Phase.Received) it else it.copy(phase = Phase.Cancelled(status.cleanup != 2)) }
      if (status.cleanup == 2) { for (g in 0 until keys.manifest.groups) group(job.id, g).delete(); File(job.asset.path).delete() }
    } else store.update(job.id) { if (it.phase is Phase.Cancelled) it else it.copy(confirmed = status.contiguous) }
  }
  fun cancel(job: TransferJob) {
    val value = state(job.id); bound(job, value)
    if (!value.getBoolean("setupAttempted")) {
      store.update(job.id) { if (it.phase is Phase.Received) it else it.copy(phase = Phase.Cancelled(false)) }
      for (g in 0 until manifest(value).groups) group(job.id, g).delete()
      File(job.asset.path).delete(); return
    }
    reconcile(job, value, keys(job.id, value), true)
  }
  fun destinationTitle(job: TransferJob): String = state(job.id).getString("title")
  fun verifyReceived(job: TransferJob) {
    val value = state(job.id); val manifest = bound(job, value); check(!value.isNull("master"))
    val keys = SealedKeys(manifest, sealedUnhex(value.getString("master")))
    val receipt = keys.receipt(android.util.Base64.decode(value.getString("receipt"), android.util.Base64.NO_WRAP))
    val shown = (job.phase as? Phase.Received)?.receipt ?: error("No received original.")
    check(sealedUUID(keys.manifest.job) == job.id && keys.manifest.originalBytes == job.asset.bytes && sealedHex(keys.manifest.originalHash) == job.asset.sha256 && receipt.id == shown.getString("id") && shown.getString("jobId") == job.id && shown.getLong("bytes") == job.asset.bytes && shown.getString("sha256") == job.asset.sha256 && Instant.parse(shown.getString("verifiedAt")).epochSecond.toULong() == receipt.verifiedAt)
  }
  fun viewer(job: TransferJob): String {
    check(job.phase is Phase.Received)
    val value = state(job.id); val keys = keys(job.id, value)
    val reply = client.control(PairingControlOperation.VIEW, keys.manifest.job, keys.query())
    val path = JSONObject(reply.toString(Charsets.UTF_8)).getString("path"); check(Regex("^/receive#[a-f0-9]{64}$").matches(path)); return keys.manifest.origin + path
  }
  fun receivedCopy(job: TransferJob): File {
    verifyReceived(job)
    val folder = File(context.cacheDir, "received-viewer").apply { check(isDirectory || mkdirs()) }
    val extension = job.asset.name.substringAfterLast('.', "mp4").lowercase().takeIf { Regex("[a-z0-9]{1,12}").matches(it) } ?: "original"
    val destination = File(folder, "${job.id}.$extension")
    fun matches(file: File): Boolean {
      if (!file.isFile || file.length() != job.asset.bytes) return false
      val hash = MessageDigest.getInstance("SHA-256"); file.inputStream().use { input -> val buffer = ByteArray(65536); while (true) { val n = input.read(buffer); if (n < 0) break; hash.update(buffer, 0, n) } }
      return sealedHex(hash.digest()) == job.asset.sha256
    }
    if (matches(destination)) return destination
    check(folder.usableSpace > job.asset.bytes + 8L * 1024 * 1024) { "Not enough space to open the received original." }
    val value = state(job.id); val keys = keys(job.id, value)
    val code = viewer(job).substringAfterLast('#'); val partial = File(folder, "${job.id}.${java.util.UUID.randomUUID()}.partial")
    try {
      client.downloadViewer(keys.manifest.job, code, partial, job.asset.bytes, job.asset.sha256)
      android.system.Os.chmod(partial.absolutePath, 384)
      check(partial.renameTo(destination)); return destination
    } finally { partial.delete() }
  }
  fun handoff(job: TransferJob, operation: Int): String {
    check(job.phase is Phase.Received) { "Wait for a verified original." }
    val value = state(job.id); val keys = keys(job.id, value)
    val op = when (operation) { 0 -> PairingControlOperation.HANDOFF_STATUS; 1 -> PairingControlOperation.DELIVER; 2 -> PairingControlOperation.SEND; else -> error("Unknown handoff.") }
    val reply = JSONObject(client.control(op, keys.manifest.job, keys.handoff(operation)).toString(Charsets.UTF_8))
    val kind = reply.getString("kind"); val sanitized = JSONObject().put("kind", kind)
    if (kind == "unavailable") return sanitized.toString()
    check(kind in listOf("not_delivered", "ready", "unknown", "sent"))
    val title = reply.getString("title"); check(title.isNotEmpty() && title.toByteArray().size <= 120 && title.none { Character.isISOControl(it) })
    sanitized.put("title", title)
    if (kind == "sent") { val id = reply.getString("messageId"); check(id.isNotEmpty() && id.toByteArray().size <= 256 && id.none { Character.isISOControl(it) }); sanitized.put("messageId", id) }
    return sanitized.toString()
  }
}
