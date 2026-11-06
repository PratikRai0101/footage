package expo.modules.footagetransfer

import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import org.junit.Test

class ReceiverOriginTest {
  @Test fun privateHttpAndHttpsOriginsAreAccepted() {
    for (origin in listOf("http://127.0.0.1:1080", "http://10.0.2.2:1083", "http://<private-lan-ip>:1080", "http://192.168.1.2", "https://receiver.example")) {
      assertEquals(origin, receiverOrigin(" $origin/ "))
    }
  }

  @Test fun publicCleartextAndNonOriginsAreRejectedBeforeAnyCapabilityIsSent() {
    for (origin in listOf("http://8.8.8.8", "http://receiver.example", "http://192.168.1.2.attacker.example", "ftp://192.168.1.2", "http://user:password@192.168.1.2", "http://192.168.1.2/jobs", "http://192.168.1.2?token=example", "http://192.168.1.2#fragment", "http://192.168.1.2:0", "http://192.168.1.2:70000")) {
      try { receiverOrigin(origin); fail("Accepted an unsafe or malformed origin: $origin") }
      catch (_: IllegalArgumentException) { }
    }
  }
}
