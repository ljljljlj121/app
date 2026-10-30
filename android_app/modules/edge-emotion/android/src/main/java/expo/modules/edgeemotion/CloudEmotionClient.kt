package expo.modules.edgeemotion

import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import android.os.SystemClock
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

data class SpeechSettings(
  val base: String = "http://183.62.69.210:9005/v1",
  val key: String = "",
  val model: String = "/data2/lzh/emo/checkpoint",
  val rms: Double = 200.0,
  val silenceMs: Long = 1000,
  val textWeight: Double = 0.75
) {
  companion object {
    fun parse(raw: String): SpeechSettings {
      val j = JSONObject(raw.ifBlank { "{}" })
      val base = j.optString("base", "http://183.62.69.210:9005/v1").trim().trimEnd('/')
      require(base.startsWith("http://") || base.startsWith("https://")) { "Invalid API address" }
      return SpeechSettings(base, j.optString("key", ""), j.optString("model", "/data2/lzh/emo/checkpoint"),
        j.optDouble("rms", 200.0).coerceIn(50.0, 10000.0),
        j.optLong("silenceMs", 1000).coerceIn(500, 3000),
        j.optDouble("textWeight", .75).coerceIn(0.0, 1.0))
    }
  }
}

class CloudEmotionClient {
  @Volatile var connection: HttpURLConnection? = null
  fun cancel() { connection?.disconnect() }
  companion object {
    private val watchdog = Executors.newSingleThreadScheduledExecutor { task ->
      Thread(task, "emotion-http-timeout").apply { isDaemon = true }
    }
    val labels = listOf("happy", "sad", "angry", "fear", "disgust", "surprise", "neutral")
    fun parseLabel(message: JSONObject): String {
      require((message.isNull("reasoning_content") || message.optString("reasoning_content").isBlank()) &&
        (message.isNull("reasoning") || message.optString("reasoning").isBlank())) {
        "Unexpected reasoning output"
      }
      val label = message.optString("content").trim().lowercase()
        .replace(Regex("^```(?:text)?\\s*|\\s*```$"), "")
        .trim(' ', '\t', '\r', '\n', '.', ',', ';', ':', '!', '?', '"', '\'')
      require(label in labels) { "Invalid seven-class label" }
      return label
    }
  }
  fun infer(video: File, audio: File, settings: SpeechSettings, cancelled: () -> Boolean): String {
    val timeout = watchdog.schedule({ cancel() }, 60, TimeUnit.SECONDS)
    try { return request(video, audio, settings, cancelled) } finally { timeout.cancel(false) }
  }
  private fun request(video: File, audio: File, settings: SpeechSettings, cancelled: () -> Boolean): String {
    require(settings.key.isNotBlank()) { "Cloud API key is not configured" }
    val encodedVideo = Base64.encodeToString(video.readBytes(), Base64.NO_WRAP)
    val encodedAudio = Base64.encodeToString(audio.readBytes(), Base64.NO_WRAP)
    val messages = JSONArray().put(JSONObject().put("role", "system").put("content", MerPrompts.system))
      .put(JSONObject().put("role", "user").put("content", JSONArray()
        .put(JSONObject().put("type", "video_url").put("video_url", JSONObject().put("url", "data:video/mp4;base64,$encodedVideo")))
        .put(JSONObject().put("type", "audio_url").put("audio_url", JSONObject().put("url", "data:audio/wav;base64,$encodedAudio")))
        .put(JSONObject().put("type", "text").put("text", MerPrompts.user))))
    val deadline = SystemClock.elapsedRealtime() + 60000
    var transientRetries = 0
    var mode = 0
    while (mode < 4) {
      check(!cancelled()) { "cancelled" }
      val remaining = deadline - SystemClock.elapsedRealtime()
      check(remaining > 0) { "Cloud request timeout" }
      val body = JSONObject().put("model", settings.model).put("messages", messages)
        .put("max_tokens", 8).put("temperature", 0).put("top_p", 1).put("seed", 0)
        .put("stop_token_ids", JSONArray(listOf(151643, 151645)))
      if (mode != 2) body.put("chat_template_kwargs", JSONObject().put("enable_thinking", false))
      if (mode == 0) body.put("structured_outputs", JSONObject().put("choice", JSONArray(labels)))
      if (mode == 1 || mode == 2) body.put("guided_choice", JSONArray(labels))
      val conn = URL("${settings.base}/chat/completions").openConnection() as HttpURLConnection
      connection = conn
      try {
        conn.requestMethod = "POST"
        conn.connectTimeout = minOf(10000, remaining.toInt())
        conn.readTimeout = minOf(30000, remaining.toInt())
        conn.doOutput = true
        conn.setRequestProperty("Authorization", "Bearer ${settings.key}")
        conn.setRequestProperty("Content-Type", "application/json")
        val data = body.toString().toByteArray(Charsets.UTF_8)
        conn.setFixedLengthStreamingMode(data.size)
        conn.outputStream.use { it.write(data) }
        val status = conn.responseCode
        if (status == 400) { mode++; continue }
        if ((status == 429 || status in 500..599) && transientRetries++ < 1) continue
        check(status in 200..299) { "Cloud HTTP $status" }
        val response = conn.inputStream.bufferedReader().use { it.readText() }
        check(!cancelled()) { "cancelled" }
        check(SystemClock.elapsedRealtime() <= deadline) { "Cloud request timeout" }
        return parseLabel(JSONObject(response).getJSONArray("choices").getJSONObject(0).getJSONObject("message"))
      } catch (error: java.io.IOException) {
        if (cancelled() || transientRetries++ >= 1 || SystemClock.elapsedRealtime() >= deadline) throw error
      } finally { conn.disconnect(); connection = null }
    }
    error("Cloud rejected all constrained output formats")
  }
}
