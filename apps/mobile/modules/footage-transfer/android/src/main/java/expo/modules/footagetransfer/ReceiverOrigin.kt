package expo.modules.footagetransfer

import java.net.URI
import java.util.Locale

internal fun receiverOrigin(input: String): String {
  val uri = URI(input.trim().trimEnd('/'))
  require(uri.scheme in listOf("http", "https") && uri.host != null && uri.userInfo == null && uri.query == null && uri.fragment == null && (uri.path.isNullOrEmpty() || uri.path == "/")) {
    "Enter only the receiver origin, for example http://192.168.1.10:1080."
  }
  require(uri.port == -1 || uri.port in 1..65535) { "Choose a receiver port between 1 and 65535." }
  if (uri.scheme == "http") {
    val host = uri.host.lowercase(Locale.ROOT).removePrefix("[").removeSuffix("]")
    val octets = host.split('.')
    val parts = octets.mapNotNull { it.toIntOrNull() }
    val privateV4 = octets.size == 4 && parts.size == 4 && parts.all { it in 0..255 } &&
      (parts[0] == 10 || parts[0] == 127 || (parts[0] == 172 && parts[1] in 16..31) ||
        (parts[0] == 192 && parts[1] == 168) || (parts[0] == 169 && parts[1] == 254))
    val privateV6 = host == "::1" || (host.contains(':') && Regex("^(fc|fd|fe[89ab])[0-9a-f:]+$").matches(host))
    require(host == "localhost" || privateV4 || privateV6) { "Local HTTP requires a private LAN IP address. Use HTTPS for a non-local receiver." }
  }
  return uri.toString().trimEnd('/')
}
