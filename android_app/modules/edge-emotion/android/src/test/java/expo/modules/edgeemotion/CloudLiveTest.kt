package expo.modules.edgeemotion

import java.io.File
import org.json.JSONObject
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Opt-in check of the actual Android HTTP client, not a Python SDK demo run. */
@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class CloudLiveTest {
  @Test fun authorizedReferencePairReturnsStrictLabel() {
    assumeTrue(System.getenv("MER_LIVE_TEST") == "1")
    val root = File(System.getenv("MER_REFERENCE_DIR") ?: error("Reference directory required"))
    val key = System.getenv("MER_TEST_KEY") ?: error("Test credential required")
    val start = System.nanoTime()
    val tag = CloudEmotionClient().infer(File(root, "angry_clip.mp4")!!, File(root, "angry_audio1.wav")!!,
      SpeechSettings(key = key)) { false }
    assertTrue(tag in CloudEmotionClient.labels)
    val report = JSONObject().put("scope", "Native HTTP client on JVM with authorized reference files; not phone capture acceptance")
      .put("label", tag).put("elapsedMs", (System.nanoTime() - start) / 1e6)
      .put("completedAt", System.currentTimeMillis())
    File("../../../docs/unified-emotion/cloud-live-verification.json").apply {
      parentFile.mkdirs(); writeText(report.toString(2))
    }
  }
}

