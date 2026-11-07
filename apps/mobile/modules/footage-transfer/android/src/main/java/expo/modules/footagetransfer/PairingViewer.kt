package expo.modules.footagetransfer

import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.security.MessageDigest

/** Read-only viewer traffic uses independent pinned sockets and a private cookie,
 * never the enrollment/upload credential or the system browser's global CA store. */
internal class PairingViewer(private val offer: PairingOffer) {
  private fun headers(input: InputStream): Pair<Int, Map<String, String>> {
    var count = 0
    fun line(): String {
      val out = ByteArrayOutputStream()
      while (true) {
        val b = input.read(); pairingCheck(b >= 0 && ++count <= 8192)
        if (b == 13) { pairingCheck(input.read() == 10 && ++count <= 8192); return out.toString("US-ASCII") }
        pairingCheck(b in 32..126); out.write(b)
      }
    }
    val status = Regex("HTTP/1\\.[01] ([0-9]{3})(?: .*)?").matchEntire(line())?.groupValues?.get(1)?.toIntOrNull() ?: error("Invalid viewer response.")
    val values = mutableMapOf<String, String>()
    while (true) { val row = line(); if (row.isEmpty()) break; val split = row.indexOf(':'); pairingCheck(split > 0); val key = row.substring(0, split).lowercase(java.util.Locale.ROOT); pairingCheck(!values.containsKey(key)); values[key] = row.substring(split + 1).trim() }
    return Pair(status, values)
  }
  fun download(code: String, destination: File, size: Long, hash: String) {
    pairingCheck(Regex("[a-f0-9]{64}").matches(code) && size in 1..1073741824L)
    val transport = PairingTransport(offer)
    val cookie = transport.withPinnedSocket { socket ->
      val body = "{\"code\":\"$code\"}".toByteArray()
      socket.outputStream.write(("POST /viewer/session HTTP/1.1\r\nHost: ${offer.origin.text.removePrefix("https://")}\r\nContent-Type: application/json\r\nContent-Length: ${body.size}\r\nConnection: close\r\n\r\n").toByteArray(Charsets.US_ASCII)); socket.outputStream.write(body); socket.outputStream.flush()
      val (status, header) = headers(socket.inputStream); pairingCheck(status == 204)
      val value = requireNotNull(header["set-cookie"]); pairingCheck(value.contains("HttpOnly") && value.contains("Secure") && value.contains("SameSite=Strict"))
      value.substringBefore(';').also { pairingCheck(Regex("footage_viewer=[a-f0-9]{64}").matches(it)) }
    }
    transport.withPinnedSocket { socket ->
      socket.soTimeout = 30000
      socket.outputStream.write(("GET /viewer/content HTTP/1.1\r\nHost: ${offer.origin.text.removePrefix("https://")}\r\nCookie: $cookie\r\nConnection: close\r\n\r\n").toByteArray(Charsets.US_ASCII)); socket.outputStream.flush()
      val (status, header) = headers(socket.inputStream)
      pairingCheck(status == 200 && header["content-length"]?.toLongOrNull() == size && !header.containsKey("content-encoding") && !header.containsKey("transfer-encoding"))
      val digest = MessageDigest.getInstance("SHA-256"); var total = 0L
      FileOutputStream(destination).use { output ->
        val buffer = ByteArray(65536)
        while (total < size) { val n = socket.inputStream.read(buffer, 0, minOf(buffer.size.toLong(), size - total).toInt()); pairingCheck(n > 0); output.write(buffer, 0, n); digest.update(buffer, 0, n); total += n }
        output.fd.sync()
      }
      pairingCheck(digest.digest().joinToString("") { "%02x".format(it) } == hash)
    }
  }
}
