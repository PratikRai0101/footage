package expo.modules.footagetransfer

import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.text.Normalizer
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

internal fun sealedNumber(value: ULong, size: Int): ByteArray = ByteArray(size) { index -> (value shr ((size - index - 1) * 8)).toByte() }
internal fun sealedUUID(value: String): ByteArray = UUID.fromString(value).let { ByteBuffer.allocate(16).putLong(it.mostSignificantBits).putLong(it.leastSignificantBits).array() }
internal fun sealedUUID(value: ByteArray): String { pairingCheck(value.size == 16); val b = ByteBuffer.wrap(value); return UUID(b.long, b.long).toString() }
internal fun sealedHex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }
internal fun sealedUnhex(value: String): ByteArray { pairingCheck(Regex("[0-9a-f]+").matches(value) && value.length % 2 == 0); return value.chunked(2).map { it.toInt(16).toByte() }.toByteArray() }
internal fun sealedMAC(key: ByteArray, bytes: ByteArray): ByteArray = Mac.getInstance("HmacSHA256").run { init(SecretKeySpec(key, "HmacSHA256")); doFinal(bytes) }

/** The canonical G2 format, shared with Swift/Node. All counters are original bytes. */
internal class SealedManifest(val bytes: ByteArray) {
  val receiver: ByteArray; val origin: String; val job: ByteArray; val generation: ByteArray; val device: ByteArray
  val epoch: ULong; val intake: ByteArray; val originalBytes: Long; val originalHash: ByteArray; val name: String; val expires: ULong
  val frameHashes: List<ByteArray>; val digest = pairingHash(bytes)
  val destinationDigest: ByteArray get() = pairingHash(byteArrayOf(1) + intake)
  val groups: Int get() = (frameHashes.size + 7) / 8
  init {
    val r = PairingReader(bytes, "FTMAN001", 65536)
    receiver = r.take(32); origin = PairingOrigin(pairingText(r.lp16(512))).text; job = r.take(16); generation = r.take(16); device = r.take(16); epoch = r.u64()
    val d = r.lp16(17); pairingCheck(d.size == 17 && d[0] == 1.toByte()); intake = d.copyOfRange(1, 17)
    val length = r.u64(); pairingCheck(length in 1u..1073741824u); originalBytes = length.toLong()
    originalHash = r.take(32); name = pairingText(r.lp16(240)); pairingCheck(name.isNotEmpty() && Normalizer.isNormalized(name, Normalizer.Form.NFC) && name.none { Character.isISOControl(it) || it == '/' || it == '\\' })
    expires = r.u64(); pairingCheck(r.u32() == FRAME && r.u16() == 8)
    val count = r.u32(); pairingCheck(count == ((originalBytes + FRAME - 1) / FRAME).toInt() && count in 1..128)
    frameHashes = List(count) { r.take(32) }; r.end()
  }
  fun binding() = PairingControlBinding(receiver, origin, device, epoch, job, generation, digest, intake, expires)
  fun frameLength(frame: Int): Int { pairingCheck(frame in frameHashes.indices); return minOf(FRAME.toLong(), originalBytes - frame.toLong() * FRAME).toInt() }
  fun groupLength(group: Int): Int { pairingCheck(group in 0 until groups); return minOf(8L * FRAME, originalBytes - group.toLong() * 8 * FRAME).toInt() }
  fun header(group: Int): ByteArray = "FTSEAL01".toByteArray() + receiver + job + generation + digest + pairingU32(group) + pairingU32(group * 8) + sealedNumber(minOf(8, frameHashes.size - group * 8).toULong(), 2) + byteArrayOf(0, 0) + pairingU64(group.toULong() * 8u * FRAME.toULong()) + pairingU32(groupLength(group))
  fun contiguous(bitmap: ULong): Long {
    pairingCheck(bitmap shr groups == 0uL)
    var total = 0L; for (g in 0 until groups) { if (bitmap and (1uL shl g) == 0uL) break; total += groupLength(g) }; return total
  }
  companion object {
    const val FRAME = 8 * 1024 * 1024
    fun create(identity: PairingInstalledIdentity, intake: ByteArray, job: ByteArray, generation: ByteArray, size: Long, hash: ByteArray, name: String, expires: ULong, frames: List<ByteArray>): SealedManifest {
      pairingCheck(intake.size == 16 && hash.size == 32 && job.size == 16 && generation.size == 16)
      return SealedManifest("FTMAN001".toByteArray() + identity.receiver + pairingLP(identity.origin.toByteArray()) + job + generation + identity.device + pairingU64(identity.epoch) + pairingLP(byteArrayOf(1) + intake) + pairingU64(size.toULong()) + hash + pairingLP(name.toByteArray()) + pairingU64(expires) + pairingU32(FRAME) + byteArrayOf(0, 8) + pairingU32(frames.size) + frames.fold(byteArrayOf()) { a, b -> a + b })
    }
  }
}
internal data class SealedReceipt(val id: String, val verifiedAt: ULong, val revision: ULong, val envelope: ByteArray)
internal data class SealedStatus(val revision: ULong, val state: Int, val cleanup: Int, val bitmap: ULong, val contiguous: Long, val receipt: SealedReceipt?)
internal class SealedKeys(val manifest: SealedManifest, master: ByteArray) {
  private val master = master.copyOf().also { pairingCheck(it.size == 32) }
  fun derive(domain: String, frame: Int? = null, seal: ByteArray? = null): ByteArray {
    pairingCheck(domain in listOf("body", "ack", "receipt", "status"))
    val info = "footage/sealed-v1/$domain".toByteArray() + if (domain == "body") { pairingCheck(frame != null && seal?.size == 16); pairingU32(requireNotNull(frame)) + requireNotNull(seal) } else byteArrayOf()
    return sealedMAC(sealedMAC(manifest.digest, master), info + byteArrayOf(1))
  }
  private fun authenticated(bytes: ByteArray, magic: String, domain: String): PairingReader {
    pairingCheck(bytes.size in 40..4096)
    val body = bytes.copyOfRange(0, bytes.size - 32)
    pairingCheck(java.security.MessageDigest.isEqual(sealedMAC(derive(domain), body), bytes.copyOfRange(bytes.size - 32, bytes.size)))
    val r = PairingReader(body, magic, 4096)
    pairingCheck(r.take(32).contentEquals(manifest.receiver) && r.take(16).contentEquals(manifest.job) && r.take(16).contentEquals(manifest.generation) && r.take(32).contentEquals(manifest.digest)); return r
  }
  fun receipt(bytes: ByteArray): SealedReceipt {
    val r = authenticated(bytes, "FTRCPT01", "receipt"); pairingCheck(r.take(32).contentEquals(manifest.destinationDigest))
    val result = SealedReceipt(sealedUUID(r.take(16)), r.u64(), r.u64(), bytes.copyOf()); r.end(); pairingCheck(result.verifiedAt <= 253402300799uL); return result
  }
  fun query(operation: ByteArray = pairingRandom(16), challenge: ByteArray = pairingRandom(32)): ByteArray = "FTQUERY1".toByteArray() + manifest.job + manifest.generation + manifest.digest + operation + challenge
  fun handoff(operation: Int): ByteArray {
    pairingCheck(operation in 0..2)
    val prefix = "FTHAND01".toByteArray() + byteArrayOf(operation.toByte()) + manifest.job + manifest.generation + manifest.digest + pairingRandom(16)
    return prefix + sealedMAC(derive("status"), "footage/handoff-request/v1".toByteArray() + prefix)
  }
  fun status(bytes: ByteArray, query: ByteArray, highWater: ULong): SealedStatus {
    pairingCheck(query.size == 120)
    val r = authenticated(bytes, "FTSTAT01", "status"); pairingCheck(r.take(16).contentEquals(query.copyOfRange(72, 88)) && r.take(32).contentEquals(query.copyOfRange(88, 120)))
    val revision = r.u64(); val state = r.take(1)[0].toInt() and 255; val cleanup = r.take(1)[0].toInt() and 255; pairingCheck(r.u64() == manifest.expires)
    val bitmap = r.u64(); val contiguous = r.u64(); val receiptBytes = r.lp32(200); r.end()
    val receipt = if (receiptBytes.isEmpty()) null else receipt(receiptBytes)
    pairingCheck(revision >= highWater && state in 1..6 && cleanup in 0..2 && contiguous == manifest.contiguous(bitmap).toULong())
    pairingCheck(if (state >= 4) cleanup in 1..2 else cleanup == 0)
    pairingCheck((state == 3) == (receipt != null) && (receipt == null || receipt.revision <= revision))
    if (state == 2 || state == 3) pairingCheck(bitmap == (1uL shl manifest.groups) - 1uL)
    return SealedStatus(revision, state, cleanup, bitmap, contiguous.toLong(), receipt)
  }
  fun outcome(bytes: ByteArray, group: Int, wire: ByteArray, highWater: ULong): Pair<ULong, SealedReceipt?> {
    val r = PairingReader(bytes, "FTOUT001", 4096); val ackBytes = r.lp32(192); val receiptBytes = r.lp32(200); r.end()
    pairingCheck(ackBytes.size == 192)
    val ack = authenticated(ackBytes, "FTACK001", "ack")
    pairingCheck(ack.u32() == group && ack.take(32).contentEquals(wire) && ack.u64() == group.toULong() * 8u * SealedManifest.FRAME.toULong() && ack.u32() == manifest.groupLength(group))
    val revision = ack.u64(); ack.end(); pairingCheck(revision >= highWater)
    val receipt = if (receiptBytes.isEmpty()) null else receipt(receiptBytes); pairingCheck(receipt == null || receipt.revision >= revision)
    return Pair(revision, receipt)
  }
  fun sealGroup(original: File, output: File, group: Int, consume: (Int, ByteArray) -> Unit): ByteArray {
    val header = manifest.header(group); val digest = java.security.MessageDigest.getInstance("SHA-256")
    RandomAccessFile(original, "r").use { input ->
      input.seek(group.toLong() * 8 * SealedManifest.FRAME)
      FileOutputStream(output).use { out ->
        fun write(bytes: ByteArray) { out.write(bytes); digest.update(bytes) }
        write(header)
        for (frame in group * 8 until minOf((group + 1) * 8, manifest.frameHashes.size)) {
          val plain = ByteArray(manifest.frameLength(frame)); input.readFully(plain); pairingCheck(pairingHash(plain).contentEquals(manifest.frameHashes[frame]))
          val seal = pairingRandom(16); consume(frame, seal) // durable consumed intent BEFORE encryption
          val nonce = pairingRandom(12)
          val aad = "FTBODY01".toByteArray() + header + pairingU32(frame) + pairingU32(plain.size) + seal
          val cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(derive("body", frame, seal), "AES"), GCMParameterSpec(128, nonce)); cipher.updateAAD(aad)
          write(pairingU32(frame) + pairingU32(plain.size) + seal + nonce); write(cipher.doFinal(plain)); plain.fill(0)
        }
        out.fd.sync()
      }
    }
    return digest.digest()
  }
}
