package expo.modules.footagetransfer

import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.PublicKey
import java.security.SecureRandom
import java.security.Signature
import java.security.spec.X509EncodedKeySpec

internal fun pairingCheck(ok: Boolean) { require(ok) { "Pairing rejected." } }
internal fun pairingHash(bytes: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(bytes)
internal fun pairingRandom(n: Int): ByteArray = ByteArray(n).also { SecureRandom().nextBytes(it) }
internal fun pairingU32(n: Int): ByteArray = ByteBuffer.allocate(4).putInt(n).array()
internal fun pairingU64(n: ULong): ByteArray = ByteBuffer.allocate(8).putLong(n.toLong()).array()
internal fun pairingLP(bytes: ByteArray): ByteArray {
  pairingCheck(bytes.size <= 65535)
  return ByteBuffer.allocate(2).putShort(bytes.size.toShort()).array() + bytes
}
internal fun pairingText(bytes: ByteArray): String = Charsets.UTF_8.newDecoder()
  .onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString()
internal class PairingReader(private val bytes: ByteArray, magic: String, limit: Int = 16384) {
  private var offset = 0
  init { pairingCheck(bytes.size <= limit && take(8).contentEquals(magic.toByteArray(Charsets.US_ASCII))) }
  fun take(n: Int): ByteArray {
    pairingCheck(n >= 0 && n <= bytes.size - offset)
    return bytes.copyOfRange(offset, offset + n).also { offset += n }
  }
  fun u16(): Int = ByteBuffer.wrap(take(2)).short.toInt() and 65535
  fun u32(): Int = ByteBuffer.wrap(take(4)).int
  fun u64(): ULong = ByteBuffer.wrap(take(8)).long.toULong()
  fun lp16(max: Int): ByteArray { val n = u16(); pairingCheck(n <= max); return take(n) }
  fun lp32(max: Int): ByteArray { val n = u32(); pairingCheck(n in 0..max); return take(n) }
  fun prefix(): ByteArray = bytes.copyOfRange(0, offset)
  fun end() { pairingCheck(offset == bytes.size) }
}
private fun pairingIPv6Groups(host: String): List<Int> {
  pairingCheck(Regex("[0-9a-fA-F:]+").matches(host))
  val sides = host.split("::"); pairingCheck(sides.size in 1..2)
  fun side(text: String): List<Int> = if (text.isEmpty()) emptyList() else text.split(':').map { pairingCheck(it.length in 1..4); it.toInt(16) }
  val left = side(sides[0])
  if (sides.size == 1) { pairingCheck(left.size == 8); return left }
  val right = side(sides[1]); val zeros = 8 - left.size - right.size; pairingCheck(zeros > 0)
  return left + List(zeros) { 0 } + right
}
internal fun pairingNumericIP(host: String): ByteArray = if (host.contains(':')) pairingIPv6Groups(host).flatMap { listOf((it shr 8).toByte(), it.toByte()) }.toByteArray()
  else host.split('.').map { pairingCheck(it.toInt() in 0..255); it.toInt().toByte() }.toByteArray().also { pairingCheck(it.size == 4) }
internal class PairingOrigin(val text: String) {
  val host: String
  val port: Int
  init {
    pairingCheck(text.toByteArray().size <= 512 && text.all { it.code in 33..126 })
    val match = Regex("^https://(\\[[0-9a-f:]+\\]|[a-z0-9.-]+):([1-9][0-9]{0,4})$").matchEntire(text)
    pairingCheck(match != null)
    val authority = requireNotNull(match).groupValues[1]; port = match.groupValues[2].toInt(); pairingCheck(port in 1..65535)
    host = authority.removePrefix("[").removeSuffix("]")
    if (authority.startsWith("[")) {
      val groups = pairingIPv6Groups(host)
      var bestStart = -1; var bestLength = 1; var i = 0
      while (i < 8) {
        if (groups[i] != 0) { i++; continue }
        val start = i; while (i < 8 && groups[i] == 0) i++
        if (i - start > bestLength) { bestStart = start; bestLength = i - start }
      }
      val canonical = if (bestStart < 0) groups.joinToString(":") { it.toString(16) }
        else groups.take(bestStart).joinToString(":") { it.toString(16) } + "::" + groups.drop(bestStart + bestLength).joinToString(":") { it.toString(16) }
      pairingCheck(host == canonical)
    } else if (host.all { it in '0'..'9' || it == '.' }) {
      val octets = host.split('.'); pairingCheck(octets.size == 4 && octets.all { it.toIntOrNull() in 0..255 && it.toInt().toString() == it })
    } else pairingCheck(host.length <= 253 && host.split('.').all { Regex("[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?").matches(it) })
  }
}
internal fun pairingP256(bytes: ByteArray): PublicKey {
  val prefix = byteArrayOf(0x30,0x59,0x30,0x13,0x06,0x07,0x2a,0x86.toByte(),0x48,0xce.toByte(),0x3d,0x02,0x01,0x06,0x08,0x2a,0x86.toByte(),0x48,0xce.toByte(),0x3d,0x03,0x01,0x07,0x03,0x42,0,0x04)
  pairingCheck(bytes.size == 91 && bytes.copyOfRange(0, prefix.size).contentEquals(prefix))
  return KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(bytes)).also { pairingCheck(it.encoded.contentEquals(bytes)) }
}
internal fun pairingVerify(key: PublicKey, prefix: ByteArray, signature: ByteArray) {
  pairingCheck(signature.size in 8..72)
  val verifier = Signature.getInstance("SHA256withECDSA"); verifier.initVerify(key); verifier.update(prefix); pairingCheck(verifier.verify(signature))
}
internal class PairingOffer(val bytes: ByteArray, fresh: Boolean = true) {
  val spki: ByteArray; val receiver: ByteArray; val ca: ByteArray; val pin: ByteArray
  val origin: PairingOrigin; val id: ByteArray; val secret: ByteArray; val expires: ULong; val mask: Int
  init {
    val r = PairingReader(bytes, "FTQR0001", 2048); spki = r.lp16(128); pairingP256(spki); receiver = pairingHash(spki)
    ca = r.lp16(1024); pin = r.take(32); origin = PairingOrigin(pairingText(r.lp16(512)))
    id = r.take(16); secret = r.take(32); expires = r.u64(); mask = r.u32(); r.end()
    pairingCheck(ca.isNotEmpty() && mask in 1..31)
    val now = (System.currentTimeMillis() / 1000).toULong(); if (fresh) pairingCheck(expires > now && expires - now <= 120u)
  }
}
internal fun pairingVerifyReply(reply: ByteArray, offer: PairingOffer, device: ByteArray, spki: ByteArray, mask: Int, nonce: ByteArray) {
  val r = PairingReader(reply, "FTENRO01"); val credential = r.take(32); val bytes = r.lp32(16384); r.end()
  val p = PairingReader(bytes, "FTPAIR01")
  pairingCheck(p.take(32).contentEquals(offer.receiver) && p.lp16(512).contentEquals(offer.origin.text.toByteArray()) && p.take(16).contentEquals(device) && p.lp16(128).contentEquals(spki))
  pairingCheck(p.u32() == mask && p.u64() > 0u && p.u64() > (System.currentTimeMillis() / 1000).toULong())
  pairingCheck(p.take(32).contentEquals(pairingHash(credential)) && p.take(32).contentEquals(nonce))
  val prefix = p.prefix(); val signature = p.lp16(72); p.end(); pairingVerify(pairingP256(offer.spki), prefix, signature)
}
internal class PairingRotation(bytes: ByteArray, old: PairingOffer, previousEpoch: ULong, nonce: ByteArray) {
  val spki: ByteArray; val pin: ByteArray; val ca: ByteArray; val origin: PairingOrigin; val epoch: ULong
  init {
    val r = PairingReader(bytes, "FTROT001"); pairingCheck(r.take(32).contentEquals(old.receiver))
    spki = r.lp16(128); pairingP256(spki); pin = r.take(32); ca = r.lp16(1024); origin = PairingOrigin(pairingText(r.lp16(512)))
    epoch = r.u64(); val expires = r.u64(); val now = (System.currentTimeMillis() / 1000).toULong()
    pairingCheck(ca.isNotEmpty() && epoch > previousEpoch && expires > now && expires - now <= 120u && r.take(32).contentEquals(nonce))
    val prefix = r.prefix(); val sig = r.lp16(72); r.end(); pairingVerify(pairingP256(old.spki), prefix, sig)
  }
}
