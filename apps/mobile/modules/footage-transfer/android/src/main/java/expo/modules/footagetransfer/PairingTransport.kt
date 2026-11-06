package expo.modules.footagetransfer

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.InetSocketAddress
import java.security.KeyStore
import java.security.SecureRandom
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocket
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

internal enum class PairingRoute(val path: String, val responseLimit: Int = 16384, val control: Boolean = false) {
  ENROLL("/pair/v1/enroll"), CHALLENGE("/pair/v1/challenge"), RECOVER("/pair/v1/recover"),
  SETUP("/sealed/v1/setup", 65536, true), STATUS("/sealed/v1/status", 4096, true), REVOKE("/sealed/v1/revoke", 4096, true), VIEW("/sealed/v1/view", 4096, true), DESTINATIONS("/pair/v1/destinations", 65536, true)
}

/** Dedicated raw TLS socket: no global HTTP cookie/cache/auth/proxy stores, no
 * redirect implementation, no caller-supplied URL. Handshake and independent
 * QR anchor/SAN/EKU/pin checks complete BEFORE writing any application bytes.
 * Blocking: native worker only, never the UI thread. */
internal class PairingTransport(private val offer: PairingOffer) {
  fun send(route: PairingRoute, body: ByteArray, credential: ByteArray? = null): ByteArray {
    pairingCheck(body.size <= if (route.control) 65536 else 16384)
    pairingCheck(if (route.control) credential?.size == 32 else credential == null)
    val anchor = CertificateFactory.getInstance("X.509").generateCertificate(ByteArrayInputStream(offer.ca)) as X509Certificate
    pairingCheck(anchor.encoded.contentEquals(offer.ca) && anchor.basicConstraints >= 0); anchor.checkValidity()
    val store = KeyStore.getInstance(KeyStore.getDefaultType()); store.load(null); store.setCertificateEntry("pairing-only", anchor)
    val factory = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()); factory.init(store)
    val delegate = factory.trustManagers.filterIsInstance<X509TrustManager>().single()
    val manager = object : X509TrustManager {
      override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf(anchor)
      override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) { throw java.security.cert.CertificateException("Client auth forbidden") }
      override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
        delegate.checkServerTrusted(chain, authType); pairingCheck(chain.isNotEmpty())
        chain.forEach { it.checkValidity() }; val leaf = chain[0]
        pairingCheck(leaf.extendedKeyUsage?.contains("1.3.6.1.5.5.7.3.1") == true)
        val host = offer.origin.host
        val ip = host.contains(':') || host.all { it in '0'..'9' || it == '.' }
        val matches = leaf.subjectAlternativeNames?.any { name ->
          if (name.size != 2) false
          else if (!ip && name[0] == 2) (name[1] as? String)?.equals(host, ignoreCase = true) == true
          else if (ip && name[0] == 7) {
            val encoded = when (val value = name[1]) { is String -> pairingNumericIP(value); is ByteArray -> value; else -> byteArrayOf() }
            encoded.contentEquals(pairingNumericIP(host))
          } else false
        } == true
        pairingCheck(matches && java.security.MessageDigest.isEqual(pairingHash(leaf.publicKey.encoded), offer.pin))
      }
    }
    val context = SSLContext.getInstance("TLS"); context.init(null, arrayOf(manager), SecureRandom())
    (context.socketFactory.createSocket() as SSLSocket).use { socket ->
      socket.soTimeout = 15000; socket.enabledProtocols = socket.supportedProtocols.filter { it == "TLSv1.2" || it == "TLSv1.3" }.toTypedArray()
      val params = socket.sslParameters; params.endpointIdentificationAlgorithm = "HTTPS"; socket.sslParameters = params
      socket.connect(InetSocketAddress(offer.origin.host, offer.origin.port), 15000)
      socket.startHandshake()
      val authority = offer.origin.text.removePrefix("https://")
      val auth = if (credential == null) "" else "Authorization: Bearer ${credential.joinToString("") { "%02x".format(it) }}\r\n"
      val header = "POST ${route.path} HTTP/1.1\r\nHost: $authority\r\n${auth}Content-Type: application/octet-stream\r\nAccept: application/octet-stream\r\nContent-Length: ${body.size}\r\nConnection: close\r\n\r\n"
      socket.outputStream.write(header.toByteArray(Charsets.US_ASCII)); socket.outputStream.write(body); socket.outputStream.flush()
      return readReply(socket.inputStream, route.responseLimit)
    }
  }
  private fun readReply(input: InputStream, limit: Int): ByteArray {
    var headerBytes = 0
    fun line(): String {
      val out = ByteArrayOutputStream()
      while (true) {
        val b = input.read(); pairingCheck(b >= 0 && ++headerBytes <= 8192)
        if (b == 13) { pairingCheck(input.read() == 10 && ++headerBytes <= 8192); return out.toString("US-ASCII") }
        pairingCheck(b in 32..126); out.write(b)
      }
    }
    pairingCheck(Regex("HTTP/1\\.[01] 200(?: .*)?").matches(line())) // all redirects/auth challenges are refused
    val headers = mutableMapOf<String, String>()
    while (true) {
      val text = line(); if (text.isEmpty()) break
      val colon = text.indexOf(':'); pairingCheck(colon > 0)
      val name = text.substring(0, colon).lowercase(java.util.Locale.ROOT)
      pairingCheck(Regex("[a-z0-9-]+").matches(name) && !headers.containsKey(name)); headers[name] = text.substring(colon + 1).trim()
    }
    pairingCheck(headers["content-type"] == "application/octet-stream" && !headers.containsKey("content-encoding"))
    val out = ByteArrayOutputStream()
    fun copy(n: Int) {
      pairingCheck(n >= 0 && n <= limit - out.size())
      var remaining = n; val buffer = ByteArray(minOf(4096, maxOf(n, 1)))
      while (remaining > 0) { val read = input.read(buffer, 0, minOf(buffer.size, remaining)); pairingCheck(read > 0); out.write(buffer, 0, read); remaining -= read }
    }
    if (headers["transfer-encoding"] == "chunked") {
      pairingCheck(!headers.containsKey("content-length"))
      while (true) {
        val size = line(); pairingCheck(Regex("[0-9A-Fa-f]{1,4}").matches(size)); val n = size.toInt(16)
        if (n == 0) { pairingCheck(line().isEmpty()); break }
        copy(n); pairingCheck(input.read() == 13 && input.read() == 10)
      }
    } else {
      pairingCheck(!headers.containsKey("transfer-encoding"))
      val n = headers["content-length"]?.toIntOrNull(); pairingCheck(n != null); copy(requireNotNull(n))
    }
    return out.toByteArray()
  }
}
