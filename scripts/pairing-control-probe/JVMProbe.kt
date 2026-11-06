package expo.modules.footagetransfer

import java.io.File
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.spec.ECGenParameterSpec

// Synthetic JVM ONLY; production Android vault is separately compiled, not run.
private class ControlVault : PairingDeviceVault {
  private var state: ByteArray? = null
  private var key: java.security.KeyPair? = null
  private val jobs = mutableMapOf<String, ByteArray>()
  fun loseInstalled() { state = null }
  fun loseConfirmation() { jobs.clear() }
  fun replaceInstalledFrom(future: ControlVault) { state = future.state?.clone(); key = future.key }
  override fun read(): ByteArray? = state?.clone()
  override fun beginKeys() { pairingCheck(key == null); key = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair() }
  override fun publicKey(): ByteArray = requireNotNull(key).public.encoded
  override fun sign(bytes: ByteArray): ByteArray = Signature.getInstance("SHA256withECDSA").run { initSign(requireNotNull(key).private); update(bytes); sign() }
  override fun save(bytes: ByteArray) { state = bytes.clone() }
  override fun readJob(job: ByteArray): ByteArray? = jobs[job.joinToString(",")]?.clone()
  override fun addJob(job: ByteArray, bytes: ByteArray) {
    val id = job.joinToString(","); val old = jobs[id]
    if (old == null) jobs[id] = bytes.clone() else pairingCheck(old.contentEquals(bytes))
  }
}
fun main(args: Array<String>) {
  val dir = File(args[0]); val role = args[1]
  var setup = false; var status = false
  val result = try {
    val qr = File(dir, "$role.qr").readBytes(); val offer = PairingOffer(qr); val vault = ControlVault(); val client = PairingClient(vault)
    client.prepareAfterNativeConfirmation(qr, offer.mask); client.enroll()
    val owner = PairingClient(vault); val i = owner.nativeIdentity()
    if (role == "expired-pairing") Thread.sleep(4000)
    val job = pairingRandom(16); val gen = pairingRandom(16)
    val intake = java.util.HexFormat.of().parseHex("6b7e0334148d496c8724e8f01f03a9c1")
    val expires = minOf((System.currentTimeMillis() / 1000).toULong() + 3600u, i.expires)
    val manifest = "FTMAN001".toByteArray() + i.receiver + pairingLP(i.origin.toByteArray()) + job + gen + i.device + pairingU64(i.epoch) + pairingLP(byteArrayOf(1) + intake) + pairingU64(1u) + pairingHash(byteArrayOf(17)) + pairingLP("synthetic.bin".toByteArray()) + pairingU64(expires) + pairingU32(8388608) + byteArrayOf(0, 8) + pairingU32(1) + pairingHash(byteArrayOf(17))
    val binding = PairingControlBinding(i.receiver, if (role == "http") i.origin.replace("https:", "http:") else if (role == "wrong-port") "https://localhost:1" else i.origin, i.device, if (role == "stale") i.epoch + 1u else i.epoch, job, gen, pairingHash(manifest), intake, expires)
    java.net.Authenticator.setDefault(object : java.net.Authenticator() {
      override fun getPasswordAuthentication() = java.net.PasswordAuthentication("synthetic", "synthetic".toCharArray())
    })
    val cookies = java.net.CookieManager(); java.net.CookieHandler.setDefault(cookies)
    cookies.cookieStore.add(java.net.URI(offer.origin.text), java.net.HttpCookie("test", "synthetic"))
    if (role != "unconfirmed") owner.confirmStandaloneAfterNativeConfirmation(binding)
    if (role == "changed-confirmation") owner.confirmStandaloneAfterNativeConfirmation(PairingControlBinding(i.receiver, i.origin, i.device, i.epoch, job, gen, pairingHash(manifest), pairingRandom(16), expires))
    if (role == "missing-confirmation") vault.loseConfirmation()
    if (role == "missing-installed") vault.loseInstalled()
    if (role == "future-pairing") {
      val futureVault = ControlVault(); val future = PairingClient(futureVault)
      future.prepareAfterNativeConfirmation(File(dir, "future-installation.qr").readBytes(), 31); future.enroll()
      pairingCheck(!future.nativeIdentity().device.contentEquals(i.device))
      vault.replaceInstalledFrom(futureVault)
    }
    if (role == "rotation-not-applied") {
      val candidate = PairingRotation(File(dir, "rotation.bin").readBytes(), offer, 1u, File(dir, "rotation.nonce").readBytes())
      val changed = PairingControlBinding(pairingHash(candidate.spki), candidate.origin.text, i.device, i.epoch, job, gen, pairingHash(manifest), intake, expires)
      pairingCheck(runCatching { owner.confirmStandaloneAfterNativeConfirmation(changed) }.isFailure)
    }
    if (role == "positive") { owner.recoverLostReply(); owner.confirmStandaloneAfterNativeConfirmation(binding) }
    val controller = PairingClient(vault)
    val body = if (role == "oversized-body") ByteArray(65537) else manifest.clone()
    if (role == "wrong-body") body[body.lastIndex] = (body.last().toInt() xor 1).toByte()
    controller.control(PairingControlOperation.SETUP, binding, body); setup = true
    val query = "FTQUERY1".toByteArray() + job + gen + pairingHash(manifest) + pairingRandom(16) + pairingRandom(32) + if (role == "wrong-query") byteArrayOf(0) else byteArrayOf()
    controller.control(PairingControlOperation.STATUS, job, query); status = true
    controller.control(PairingControlOperation.REVOKE, job, query)
    controller.control(PairingControlOperation.VIEW, job, query); controller.listDestinations()
    "\"success\":true,\"received\":false"
  } catch (_: Exception) { "\"success\":false" }
  File(dir, "$role.result.json").writeText("{$result,\"setup\":$setup,\"status\":$status}")
}
