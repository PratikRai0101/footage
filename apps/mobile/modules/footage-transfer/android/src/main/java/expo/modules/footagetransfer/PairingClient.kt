package expo.modules.footagetransfer

/** Native-only boundary. Android implementation owns non-exportable signing and
 * wrapping keys; tests can inject a generated in-memory signer, never a fallback. */
internal interface PairingDeviceVault {
  fun read(): ByteArray?
  fun beginKeys()
  fun publicKey(): ByteArray
  fun sign(bytes: ByteArray): ByteArray
  fun save(bytes: ByteArray)
  fun readJob(job: ByteArray): ByteArray?
  fun addJob(job: ByteArray, bytes: ByteArray)
}
internal class PairingClient(private val vault: PairingDeviceVault) {
  private class Saved(val offer: PairingOffer, val device: ByteArray, val mask: Int, val installed: ByteArray) {
    fun encode(reply: ByteArray): ByteArray = "FTANDR01".toByteArray() + pairingLP(offer.bytes) + device + pairingU32(mask) + pairingLP(reply)
    companion object {
      fun parse(bytes: ByteArray): Saved {
        val r = PairingReader(bytes, "FTANDR01"); val offer = PairingOffer(r.lp16(2048), fresh = false)
        val device = r.take(16); val mask = r.u32(); val installed = r.lp16(16384); r.end(); pairingCheck(mask in 0..31 && mask and offer.mask == mask)
        return Saved(offer, device, mask, installed)
      }
    }
  }
  private fun saved(): Saved = Saved.parse(requireNotNull(vault.read()) { "Native pairing unavailable." }).also { pairingP256(vault.publicKey()) }
  @Synchronized fun prepareAfterNativeConfirmation(qr: ByteArray, mask: Int) {
    pairingCheck(vault.read() == null); val offer = PairingOffer(qr); pairingCheck(mask in 0..31 && mask and offer.mask == mask)
    vault.beginKeys(); vault.save(Saved(offer, pairingRandom(16), mask, byteArrayOf()).encode(byteArrayOf()))
  }
  @Synchronized fun replaceAfterNativeConfirmation(qr: ByteArray, mask: Int) {
    val offer = PairingOffer(qr); pairingCheck(mask in 0..31 && mask and offer.mask == mask)
    if (vault.read() == null) vault.beginKeys() else pairingP256(vault.publicKey())
    vault.save(Saved(offer, pairingRandom(16), mask, byteArrayOf()).encode(byteArrayOf()))
  }
  fun sendGroup(job: ByteArray, file: java.io.File, active: () -> Boolean, socketChanged: (javax.net.ssl.SSLSocket?) -> Unit = {}): ByteArray {
    val installed = PairingControlInstallation.fromSaved(requireNotNull(vault.readJob(job)))
    return PairingTransport(installed.offer).sendFile(file, active, socketChanged)
  }
  fun downloadViewer(job: ByteArray, code: String, file: java.io.File, bytes: Long, hash: String) {
    val installed = PairingControlInstallation.fromSaved(requireNotNull(vault.readJob(job)))
    PairingViewer(installed.offer).download(code, file, bytes, hash)
  }
  @Synchronized fun enroll() {
    val s = saved(); pairingCheck(s.installed.isEmpty() && s.offer.expires > (System.currentTimeMillis() / 1000).toULong())
    val nonce = pairingRandom(32)
    val prefix = "FTENRL01".toByteArray() + s.offer.id + s.offer.secret + s.device + pairingLP(vault.publicKey()) + nonce + pairingU32(s.mask)
    val signature = vault.sign(prefix + s.offer.receiver + pairingLP(s.offer.origin.text.toByteArray()))
    install(PairingTransport(s.offer).send(PairingRoute.ENROLL, prefix + pairingLP(signature)), s, nonce)
  }
  @Synchronized fun recoverLostReply() {
    val s = saved(); val nonce = pairingRandom(32)
    val bytes = PairingTransport(s.offer).send(PairingRoute.CHALLENGE, "FTCHAL01".toByteArray() + s.offer.id + s.device + nonce)
    val r = PairingReader(bytes, "FTCHLO01"); pairingCheck(r.take(32).contentEquals(nonce)); val challenge = r.take(32); val expires = r.u64(); r.end()
    val now = (System.currentTimeMillis() / 1000).toULong(); pairingCheck(expires > now && expires - now <= 60u)
    val prefix = "FTRECV01".toByteArray() + s.offer.id + s.device + nonce + challenge
    val signature = vault.sign(prefix + s.offer.receiver + pairingLP(s.offer.origin.text.toByteArray()))
    install(PairingTransport(s.offer).send(PairingRoute.RECOVER, prefix + pairingLP(signature)), s, nonce)
  }
  private fun install(reply: ByteArray, s: Saved, nonce: ByteArray) {
    pairingVerifyReply(reply, s.offer, s.device, vault.publicKey(), s.mask, nonce)
    vault.save(s.encode(reply))
  }
  @Synchronized fun isInstalled(): Boolean = saved().installed.isNotEmpty()
  private class Installed(val saved: Saved, val credential: ByteArray, val epoch: ULong, val expires: ULong)
  private fun installed(): Installed {
    val s = saved(); val r = PairingReader(s.installed, "FTENRO01"); val credential = r.take(32); val p = PairingReader(r.lp32(16384), "FTPAIR01"); r.end()
    p.take(32); p.lp16(512); p.take(16); p.lp16(128); p.u32(); val epoch = p.u64(); val expires = p.u64(); p.take(32); val nonce = p.take(32)
    pairingVerifyReply(s.installed, s.offer, s.device, vault.publicKey(), s.mask, nonce)
    return Installed(s, credential, epoch, expires)
  }
  @Synchronized fun nativeIdentity(): PairingInstalledIdentity {
    val i = installed(); return PairingInstalledIdentity(i.saved.offer.receiver, i.saved.offer.origin.text, i.saved.device, i.epoch, i.expires, i.saved.mask)
  }
  @Synchronized fun confirmStandaloneAfterNativeConfirmation(binding: PairingControlBinding) {
    val i = installed(); binding.validate(i.saved.offer, i.saved.device, i.epoch, i.expires, true)
    val item = PairingControlInstallation(binding, i.saved.offer, vault.publicKey(), i.saved.mask, i.saved.installed)
    val existing = vault.readJob(binding.job)
    if (existing == null) vault.addJob(binding.job, item.bytes())
    else {
      val saved = PairingControlInstallation.fromSaved(existing)
      pairingCheck(saved.binding.bytes().contentEquals(binding.bytes()) && saved.authorityDigest().contentEquals(item.authorityDigest()))
    }
  }
  @Synchronized fun control(operation: PairingControlOperation, binding: PairingControlBinding, canonicalBody: ByteArray): ByteArray {
    val installed = PairingControlInstallation.fromSaved(requireNotNull(vault.readJob(binding.job)))
    pairingCheck(installed.binding.bytes().contentEquals(binding.bytes()) && installed.mask and operation.permission == operation.permission)
    binding.validate(installed.offer, binding.deviceBytes(), installed.epoch, installed.expires, operation == PairingControlOperation.SETUP)
    binding.validateBody(canonicalBody, operation)
    return PairingTransport(installed.offer).send(operation.route, canonicalBody, installed.credential)
  }
  @Synchronized fun control(operation: PairingControlOperation, job: ByteArray, canonicalBody: ByteArray): ByteArray {
    pairingCheck(job.size == 16)
    val saved = requireNotNull(vault.readJob(job))
    val binding = PairingControlInstallation.fromSaved(saved).binding; pairingCheck(binding.job.contentEquals(job))
    return control(operation, binding, canonicalBody)
  }
  @Synchronized fun listDestinations(): ByteArray {
    val i = installed(); pairingCheck(i.saved.mask and 0x10 != 0)
    return PairingTransport(i.saved.offer).send(PairingRoute.DESTINATIONS, "FTLIST01".toByteArray() + i.saved.device + pairingU64(i.epoch) + pairingRandom(32), i.credential)
  }
}
