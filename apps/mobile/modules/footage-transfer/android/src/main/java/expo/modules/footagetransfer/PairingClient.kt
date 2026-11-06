package expo.modules.footagetransfer

/** Native-only boundary. Android implementation owns non-exportable signing and
 * wrapping keys; tests can inject a generated in-memory signer, never a fallback. */
internal interface PairingDeviceVault {
  fun read(): ByteArray?
  fun beginKeys()
  fun publicKey(): ByteArray
  fun sign(bytes: ByteArray): ByteArray
  fun save(bytes: ByteArray)
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
}
