package expo.modules.footagetransfer

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.system.Os
import android.system.OsConstants
import android.util.AtomicFile
import java.io.File
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Native only, not exported from any Expo module. No backup/JS preference copy.
 * Missing keys with existing state (including partial begin) fail closed. An
 * explicit scanner/re-pair UX must own cleanup; this class never regenerates. */
internal class PairingAndroidVault(context: Context) : PairingDeviceVault {
  private val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
  private val signing = "footage.pairing.signing.v1"
  private val wrapping = "footage.pairing.wrapping.v1"
  private val aad = "footage.pairing.native-state.v1".toByteArray()
  private val dir = File(context.noBackupFilesDir, "pairing-v1").apply {
    pairingCheck(isDirectory || mkdirs()); Os.chmod(absolutePath, 448) // 0700
  }
  private val file = AtomicFile(File(dir, "state"))
  @Synchronized override fun beginKeys() {
    pairingCheck(!file.baseFile.exists() && !keyStore.containsAlias(signing) && !keyStore.containsAlias(wrapping))
    KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore").apply {
      initialize(KeyGenParameterSpec.Builder(signing, KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY)
        .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1")).setDigests(KeyProperties.DIGEST_SHA256).setUserAuthenticationRequired(false).build())
    }.generateKeyPair()
    KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
      init(KeyGenParameterSpec.Builder(wrapping, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256).setUserAuthenticationRequired(false).build())
    }.generateKey()
  }
  @Synchronized override fun publicKey(): ByteArray = requireNotNull(keyStore.getCertificate(signing)) { "Pairing key unavailable." }.publicKey.encoded.also { pairingP256(it) }
  @Synchronized override fun sign(bytes: ByteArray): ByteArray {
    val key = keyStore.getKey(signing, null); pairingCheck(key is PrivateKey)
    val signature = Signature.getInstance("SHA256withECDSA"); signature.initSign(key as PrivateKey); signature.update(bytes); return signature.sign()
  }
  private fun bounded(input: java.io.InputStream, cap: Int): ByteArray = input.use {
    val output = java.io.ByteArrayOutputStream(); val buffer = ByteArray(1024)
    while (true) { val n = it.read(buffer); if (n < 0) break; pairingCheck(n <= cap - output.size()); output.write(buffer, 0, n) }
    output.toByteArray()
  }
  private fun secretKey(): SecretKey = requireNotNull(keyStore.getKey(wrapping, null) as? SecretKey) { "Pairing key unavailable." }
  @Synchronized override fun read(): ByteArray? {
    if (!file.baseFile.exists() && !File(file.baseFile.path + ".bak").exists()) {
      pairingCheck(!keyStore.containsAlias(signing) && !keyStore.containsAlias(wrapping)); return null
    }
    val bytes = bounded(file.openRead(), 16412); pairingCheck(bytes.size in 28..16412); publicKey()
    val cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(128, bytes.copyOfRange(0, 12))); cipher.updateAAD(aad)
    return cipher.doFinal(bytes.copyOfRange(12, bytes.size))
  }
  private fun jobFile(job: ByteArray): File {
    pairingCheck(job.size == 16)
    return File(dir, "job-" + job.joinToString("") { "%02x".format(it) })
  }
  @Synchronized override fun readJob(job: ByteArray): ByteArray? {
    val item = jobFile(job)
    if (!item.exists()) return null
    pairingCheck(Os.lstat(item.absolutePath).st_mode and OsConstants.S_IFMT == OsConstants.S_IFREG)
    val bytes = bounded(item.inputStream(), 4124); pairingCheck(bytes.size in 28..4124)
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(128, bytes.copyOfRange(0, 12))); cipher.updateAAD(aad + job)
    return cipher.doFinal(bytes.copyOfRange(12, bytes.size))
  }
  @Synchronized override fun addJob(job: ByteArray, bytes: ByteArray) {
    pairingCheck(bytes.size <= 4096)
    val existing = readJob(job)
    if (existing != null) { pairingCheck(existing.contentEquals(bytes)); return }
    val cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, secretKey()); cipher.updateAAD(aad + job)
    val encrypted = cipher.iv + cipher.doFinal(bytes); pairingCheck(cipher.iv.size == 12)
    val item = jobFile(job)
    // Exclusive creation: an interrupted write stays corrupt/blocked, not absent
    // authority that can be silently rebound to another confirmation.
    val fd = Os.open(item.absolutePath, OsConstants.O_WRONLY or OsConstants.O_CREAT or OsConstants.O_EXCL or OsConstants.O_NOFOLLOW, 384)
    java.io.FileOutputStream(fd).use { it.write(encrypted); it.fd.sync() }
    val directory = Os.open(dir.absolutePath, OsConstants.O_RDONLY, 0)
    try { Os.fsync(directory) } finally { Os.close(directory) }
  }
  @Synchronized override fun save(bytes: ByteArray) {
    pairingCheck(bytes.size <= 16384); publicKey()
    val cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, secretKey()); cipher.updateAAD(aad)
    val encrypted = cipher.iv + cipher.doFinal(bytes); pairingCheck(cipher.iv.size == 12)
    val output = file.startWrite()
    try {
      Os.fchmod(output.fd, 384); output.write(encrypted); output.fd.sync(); file.finishWrite(output)
      val descriptor = Os.open(dir.absolutePath, OsConstants.O_RDONLY, 0)
      try { Os.fsync(descriptor) } finally { Os.close(descriptor) }
    }
    catch (error: Exception) { file.failWrite(output); throw error }
  }
}
