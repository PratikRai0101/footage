package expo.modules.footagetransfer

import java.io.File
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.spec.ECGenParameterSpec

// JVM harness ONLY. Does NOT exercise AndroidKeyStore or AtomicFile. Never used
// by production, no exported private keys, and no default/fallback native vault.
private class TestVault : PairingDeviceVault {
  private var state: ByteArray? = null
  private var key: KeyPair? = null
  override fun read(): ByteArray? = state?.clone()
  override fun beginKeys() {
    pairingCheck(key == null)
    key = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
  }
  override fun publicKey(): ByteArray = requireNotNull(key).public.encoded
  override fun sign(bytes: ByteArray): ByteArray = Signature.getInstance("SHA256withECDSA").run { initSign(requireNotNull(key).private); update(bytes); sign() }
  override fun save(bytes: ByteArray) { state = bytes.clone() }
}
fun main(args: Array<String>) {
  val dir = File(args[0]); val name = args[1]
  var result: String
  try {
    val qr = File(dir, "$name.qr").readBytes(); val vault = TestVault(); val client = PairingClient(vault)
    java.net.Authenticator.setDefault(object : java.net.Authenticator() {
      override fun getPasswordAuthentication() = java.net.PasswordAuthentication("synthetic", "not-a-real-secret".toCharArray())
    })
    val cookies = java.net.CookieManager(); java.net.CookieHandler.setDefault(cookies)
    runCatching { cookies.cookieStore.add(java.net.URI(PairingOffer(qr).origin.text), java.net.HttpCookie("synthetic", "not-a-real-secret")) }
    if (name == "positive") {
      for (value in listOf("https://localhost:443", "https://127.0.0.1:443", "https://[::]:443", "https://[2001:db8::1]:443", "https://[::ffff:c000:201]:443")) PairingOrigin(value)
      for (value in listOf("http://localhost:443", "https://LOCALHOST:443", "https://localhost", "https://localhost:0443", "https://localhost.:443", "https://localhost:443/", "https://127.01.0.1:443", "https://[0:0:0:0:0:0:0:1]:443")) {
        var rejected = false; try { PairingOrigin(value) } catch (_: Exception) { rejected = true }; pairingCheck(rejected)
      }
      val zeroMask = qr.clone(); pairingU32(0).copyInto(zeroMask, zeroMask.size - 4); pairingCheck(PairingOffer(zeroMask).mask == 0)
      for (n in qr.indices) {
        var rejected = false; try { PairingOffer(qr.copyOfRange(0, n)) } catch (_: Exception) { rejected = true }; pairingCheck(rejected)
      }
      var rejected = false; try { PairingOffer(qr + byteArrayOf(0)) } catch (_: Exception) { rejected = true }; pairingCheck(rejected)
    }
    client.prepareAfterNativeConfirmation(qr, 3)
    if (name == "lost") {
      var lost = false; try { client.enroll() } catch (_: Exception) { lost = true }; pairingCheck(lost)
      val restored = PairingClient(vault); restored.recoverLostReply(); pairingCheck(restored.isInstalled())
    } else {
      client.enroll(); pairingCheck(client.isInstalled()); client.recoverLostReply(); pairingCheck(client.isInstalled())
    }
    if (name == "positive") {
      val bytes = File(dir, "rotation.bin").readBytes(); val nonce = File(dir, "rotation.nonce").readBytes(); val old = PairingOffer(qr, fresh = false)
      pairingCheck(PairingRotation(bytes, old, 1u, nonce).epoch == 2uL)
      var rejected = false; try { PairingRotation(bytes, old, 2u, nonce) } catch (_: Exception) { rejected = true }; pairingCheck(rejected)
    }
    result = "{\"success\":true,\"installed\":true}"
  } catch (error: Throwable) {
    result = "{\"success\":false,\"errorClass\":\"${error.javaClass.simpleName}\"}"
  }
  File(dir, "$name.result.json").writeText(result)
}
