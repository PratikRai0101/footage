package expo.modules.footagetransfer

internal class PairingInstalledIdentity(receiver: ByteArray, val origin: String, device: ByteArray, val epoch: ULong, val expires: ULong, val permissions: Int) {
  private val receiverId = receiver.copyOf(); private val deviceId = device.copyOf()
  val receiver: ByteArray get() = receiverId.copyOf()
  val device: ByteArray get() = deviceId.copyOf()
}

/** Native minimal authority context, not display manifest or JS contract. All
 * arrays are defensively owned; modifying caller buffers cannot change a job. */
internal class PairingControlBinding(receiver: ByteArray, origin: String, device: ByteArray, val epoch: ULong,
  job: ByteArray, generation: ByteArray, manifestDigest: ByteArray, intake: ByteArray, val expires: ULong) {
  private val receiver = receiver.copyOf()
  private val origin = PairingOrigin(origin).text
  private val device = device.copyOf()
  private val jobId = job.copyOf()
  val job: ByteArray get() = jobId.copyOf()
  private val generation = generation.copyOf()
  private val digest = manifestDigest.copyOf()
  private val intake = intake.copyOf()
  init { pairingCheck(receiver.size == 32 && device.size == 16 && job.size == 16 && generation.size == 16 && manifestDigest.size == 32 && intake.size == 16 && epoch > 0u) }
  companion object {
    fun fromSaved(bytes: ByteArray): PairingControlBinding {
      val r = PairingReader(bytes, "FTCTL001")
      val receiver = r.take(32); val origin = pairingText(r.lp32(512)); val device = r.take(16); val epoch = r.u64()
      val job = r.take(16); val generation = r.take(16); val digest = r.take(32); val intake = r.take(16); val expires = r.u64(); r.end()
      return PairingControlBinding(receiver, origin, device, epoch, job, generation, digest, intake, expires)
    }
  }
  fun deviceBytes(): ByteArray = device.copyOf()
  fun bytes(): ByteArray = "FTCTL001".toByteArray() + receiver + pairingU32(origin.toByteArray().size) + origin.toByteArray() + device + pairingU64(epoch) + jobId + generation + digest + intake + pairingU64(expires)
  fun validate(offer: PairingOffer, device: ByteArray, epoch: ULong, expires: ULong, fresh: Boolean) {
    pairingCheck(receiver.contentEquals(offer.receiver) && origin == offer.origin.text && this.device.contentEquals(device) && this.epoch == epoch && this.expires <= expires)
    if (fresh) pairingCheck(this.expires > (System.currentTimeMillis() / 1000).toULong())
  }
  fun validateBody(body: ByteArray, operation: PairingControlOperation) {
    pairingCheck(body.size <= 65536)
    if (operation == PairingControlOperation.SETUP) {
      pairingCheck(pairingHash(body).contentEquals(digest))
      val r = PairingReader(body, "FTMAN001", 65536)
      pairingCheck(r.take(32).contentEquals(receiver) && r.lp16(512).contentEquals(origin.toByteArray()) && r.take(16).contentEquals(jobId) && r.take(16).contentEquals(generation) && r.take(16).contentEquals(device) && r.u64() == epoch && r.lp16(17).contentEquals(byteArrayOf(1) + intake))
      r.u64(); r.take(32); r.lp16(240); pairingCheck(r.u64() == expires)
    } else {
      val r = PairingReader(body, "FTQUERY1", 65536)
      pairingCheck(r.take(16).contentEquals(jobId) && r.take(16).contentEquals(generation) && r.take(32).contentEquals(digest))
      r.take(16); r.take(32); r.end()
    }
  }
}
internal class PairingControlInstallation(val binding: PairingControlBinding, val offer: PairingOffer, private val spki: ByteArray, val mask: Int, private val reply: ByteArray) {
  val credential: ByteArray
  val epoch: ULong
  val expires: ULong
  init {
    pairingCheck(mask in 0..31 && mask and offer.mask == mask)
    val r = PairingReader(reply, "FTENRO01"); credential = r.take(32); val p = PairingReader(r.lp32(16384), "FTPAIR01"); r.end()
    p.take(32); p.lp16(512); p.take(16); p.lp16(128); p.u32(); epoch = p.u64(); expires = p.u64(); p.take(32); val nonce = p.take(32)
    pairingVerifyReply(reply, offer, binding.deviceBytes(), spki, mask, nonce)
    binding.validate(offer, binding.deviceBytes(), epoch, expires, false)
  }
  fun bytes(): ByteArray = ("FTCTLA01".toByteArray() + pairingLP(binding.bytes()) + pairingLP(offer.bytes) + pairingLP(spki) + pairingU32(mask) + pairingLP(reply)).also { pairingCheck(it.size <= 4096) }
  fun authorityDigest(): ByteArray = pairingHash(pairingLP(offer.spki) + pairingLP(offer.ca) + offer.pin + pairingLP(offer.origin.text.toByteArray()) + binding.deviceBytes() + spki + pairingU32(mask) + pairingU64(epoch) + pairingU64(expires) + pairingHash(credential))
  companion object {
    fun fromSaved(bytes: ByteArray): PairingControlInstallation {
      val r = PairingReader(bytes, "FTCTLA01", 4096)
      val binding = PairingControlBinding.fromSaved(r.lp16(1024)); val offer = PairingOffer(r.lp16(2048), fresh = false)
      val spki = r.lp16(128); val mask = r.u32(); val reply = r.lp16(16384); r.end()
      return PairingControlInstallation(binding, offer, spki, mask, reply)
    }
  }
}
internal enum class PairingControlOperation(val permission: Int, val route: PairingRoute) {
  SETUP(0x01, PairingRoute.SETUP), STATUS(0x02, PairingRoute.STATUS), REVOKE(0x04, PairingRoute.REVOKE), VIEW(0x08, PairingRoute.VIEW)
}
