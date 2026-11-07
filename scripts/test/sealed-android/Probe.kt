package expo.modules.footagetransfer
import java.io.File

fun main(args: Array<String>) {
  val directory = File(args[0]); val manifest = SealedManifest(File(directory, "manifest").readBytes())
  val keys = SealedKeys(manifest, File(directory, "master").readBytes())
  if (args[1] == "seal") {
    var consumed = 0
    for (g in 0 until manifest.groups) keys.sealGroup(File(directory, "original"), File(directory, "group-$g"), g) { frame, _ -> check(frame == consumed++); File(directory, "consumed").writeText(consumed.toString()) }
    File(directory, "query").writeBytes(keys.query()); File(directory, "handoff").writeBytes(keys.handoff(2))
    check(consumed == manifest.frameHashes.size)
  } else {
    val query = File(directory, "query").readBytes(); val bytes = File(directory, "status").readBytes()
    val result = keys.status(bytes, query, 1uL); check(result.state == 3 && result.contiguous == manifest.originalBytes && result.receipt != null)
    val outcome = keys.outcome(File(directory, "outcome").readBytes(), manifest.groups - 1, File(directory, "wire").readBytes(), 1uL)
    check(outcome.second?.id == result.receipt.id)
    fun rejected(action: () -> Unit) { var rejected = false; try { action() } catch (_: Exception) { rejected = true }; check(rejected) }
    rejected { keys.status(bytes.copyOf().also { it[it.lastIndex] = (it.last().toInt() xor 1).toByte() }, query, 1uL) }
    rejected { keys.status(bytes, query.copyOf().also { it[88] = (it[88].toInt() xor 1).toByte() }, 1uL) }
    rejected { keys.status(bytes, query, result.revision + 1uL) }
    rejected { SealedKeys(manifest, pairingRandom(32)).status(bytes, query, 0uL) }
  }
  println("PASS " + args[1])
}
