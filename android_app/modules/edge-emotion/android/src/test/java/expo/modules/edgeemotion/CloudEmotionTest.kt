package expo.modules.edgeemotion

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.net.ServerSocket
import java.io.File
import java.io.ByteArrayOutputStream
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class CloudEmotionTest {
  @Test fun embeddedCredentialFillsMissingOrBlankKeyWithoutChangingOverrides() {
    assertTrue("Build must include a deployment credential", BuildConfig.CLOUD_API_KEY.isNotBlank())
    assertTrue(SpeechSettings().key == BuildConfig.CLOUD_API_KEY)
    assertTrue(SpeechSettings.parse("{}").key == BuildConfig.CLOUD_API_KEY)
    assertTrue(SpeechSettings.parse("""{"key":"  "}""").key == BuildConfig.CLOUD_API_KEY)
    assertEquals("custom-test-key", SpeechSettings.parse("""{"key":"custom-test-key"}""").key)
  }
  @Test fun strictSevenLabelsNoNeutralFallback() {
    for (label in CloudEmotionClient.labels) {
      assertEquals(label, CloudEmotionClient.parseLabel(JSONObject().put("content", label)))
    }
    assertEquals("angry", CloudEmotionClient.parseLabel(JSONObject().put("content", "```text\nangry\n```")))
    assertEquals("happy", CloudEmotionClient.parseLabel(JSONObject().put("content", " happy. ").put("reasoning_content", JSONObject.NULL)))
    for (invalid in listOf("", "positive", "sad or angry", "I think neutral", "<think>x</think>happy")) {
      assertThrows(IllegalArgumentException::class.java) {
        CloudEmotionClient.parseLabel(JSONObject().put("content", invalid))
      }
    }
    assertThrows(IllegalArgumentException::class.java) {
      CloudEmotionClient.parseLabel(JSONObject().put("content", "neutral").put("reasoning_content", "analysis"))
    }
  }
  @Test fun constrainedFallbackAndLimitedTransientRetryUseActualClient() {
    val counter = AtomicInteger()
    val server = ServerSocket(0).apply { soTimeout = 10000 }
    val worker = Executors.newSingleThreadExecutor()
    val handled = worker.submit {
      repeat(3) { server.accept().use { socket ->
      socket.soTimeout = 10000
      val input = socket.getInputStream()
      val header = ByteArrayOutputStream()
      while (!header.toString("US-ASCII").endsWith("\r\n\r\n")) {
        val byte = input.read(); check(byte >= 0); header.write(byte)
        check(header.size() < 16384)
      }
      val length = Regex("Content-Length: (\\d+)", RegexOption.IGNORE_CASE)
        .find(header.toString("US-ASCII"))!!.groupValues[1].toInt()
      val payload = ByteArray(length)
      var offset = 0
      while (offset < length) {
        val count = input.read(payload, offset, length - offset); check(count > 0); offset += count
      }
      val body = JSONObject(String(payload, Charsets.UTF_8))
      assertEquals(2, body.getJSONArray("messages").length())
      val content = body.getJSONArray("messages").getJSONObject(1).getJSONArray("content")
      assertTrue(content.getJSONObject(0).getJSONObject("video_url").getString("url").startsWith("data:video/mp4;base64,"))
      assertTrue(content.getJSONObject(1).getJSONObject("audio_url").getString("url").startsWith("data:audio/wav;base64,"))
      val n = counter.incrementAndGet()
      val code = when (n) { 1 -> 400; 2 -> 503; else -> 200 }
      if (n == 1) assertTrue(body.has("structured_outputs")) else assertTrue(body.has("guided_choice"))
      val result = if (code == 200) """{"choices":[{"message":{"content":"sad"}}]}""" else "{}"
      val bytes = result.toByteArray()
      socket.getOutputStream().apply {
        write("HTTP/1.1 $code Response\r\nContent-Type: application/json\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n".toByteArray())
        write(bytes); flush()
      }
      } }
    }
    val video = File.createTempFile("video", ".mp4").apply { writeBytes(byteArrayOf(1, 2)) }
    val audio = File.createTempFile("audio", ".wav").apply { writeBytes(byteArrayOf(3, 4)) }
    try {
      val result = CloudEmotionClient().infer(video, audio,
        SpeechSettings(base = "http://127.0.0.1:${server.localPort}/v1", key = "test")) { false }
      handled.get(10, TimeUnit.SECONDS)
      assertEquals("sad", result)
      assertEquals(3, counter.get())
      assertThrows(IllegalStateException::class.java) {
        CloudEmotionClient().infer(video, audio, SpeechSettings(key = "test")) { true }
      }
      assertEquals(3, counter.get())
    } finally { server.close(); worker.shutdownNow(); video.delete(); audio.delete() }
  }
}
