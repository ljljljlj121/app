package expo.modules.edgeemotion

import android.graphics.Bitmap
import android.graphics.Color
import android.media.MediaExtractor
import android.media.MediaFormat
import android.os.SystemClock
import android.util.Log
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import kotlin.math.abs

@RunWith(AndroidJUnit4::class)
class UnifiedRuntimeTest {
  @Test fun residentAndroidAsrAndTextModelsLoadAndInfer() {
    val instrument = InstrumentationRegistry.getInstrumentation()
    val context = instrument.targetContext
    val fixtures = instrument.context.assets
    val report = JSONObject().put("device", android.os.Build.MODEL).put("sdk", android.os.Build.VERSION.SDK_INT)
      .put("scope", "Android runtime correctness sample; not microphone/camera performance acceptance")
    val start = SystemClock.elapsedRealtime()
    LocalSpeechEngine(context).use { engine ->
      report.put("loadMs", SystemClock.elapsedRealtime() - start)
      val bytes = fixtures.open("unified/asr-0.wav").use { it.readBytes() }
      val wav = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
      wav.position(12)
      var pcm: ShortArray? = null
      while (wav.remaining() >= 8) {
        val name = ByteArray(4); wav.get(name); val size = wav.int
        if (String(name) == "data") {
          pcm = ShortArray(size / 2) { wav.short }; break
        }
        wav.position(wav.position() + size + size % 2)
      }
      val asrStart = SystemClock.elapsedRealtime()
      val text = engine.transcribe(pcm ?: error("No PCM data"))
      val reference = fixtures.open("unified/asr-reference.txt").bufferedReader().use { it.readText() }
      assertEquals(reference, text)
      report.put("asrMs", SystemClock.elapsedRealtime() - asrStart).put("text", text)
      val rows = JSONArray(fixtures.open("unified/text-cases.json").bufferedReader().use { it.readText() })
      var maxError = 0.0
      for (i in 0 until rows.length()) {
        val row = rows.getJSONObject(i)
        if (!row.has("probabilities")) continue
        val (p, chunks) = engine.classify(row.getString("text"))
        assertEquals(1, chunks)
        val expected = row.getJSONArray("probabilities")
        for (j in 0..2) maxError = maxOf(maxError, abs(p!![j] - expected.getDouble(j)))
      }
      assertTrue("Text probability error $maxError", maxError < .001)
      val (longResult, chunks) = engine.classify("我很高兴，今天真的很开心。".repeat(30))
      assertTrue(chunks > 1)
      assertNotNull(longResult)
      val (empty, count) = engine.classify(" \n ")
      assertNull(empty); assertEquals(0, count)
      report.put("maxTextProbabilityError", maxError).put("longTextChunks", chunks)
      report.put("asrTextEmotion", engine.classify(text).first?.let { SpeechMath.label(it) })
      report.put("javaHeapBytes", Runtime.getRuntime().totalMemory() - Runtime.getRuntime().freeMemory())
    }
    File(context.filesDir, "unified-runtime-report.json").writeText(report.toString(2))
    Log.i("UNIFIED_VALIDATION", report.toString())
  }

  @Test fun finalizedMp4AndWavShareDurationAndAreReadable() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val frames = (0..9).map { i ->
      val image = Bitmap.createBitmap(320, 240, Bitmap.Config.ARGB_8888).apply {
        eraseColor(Color.rgb(i * 20, 60, 160))
      }
      val bytes = ByteArrayOutputStream().use { out ->
        image.compress(Bitmap.CompressFormat.JPEG, 65, out); out.toByteArray()
      }
      image.recycle()
      VideoEvidence(i * 100L, bytes)
    }
    val video = File(context.cacheDir, "unified-media-test.mp4")
    val audio = File(context.cacheDir, "unified-media-test.wav")
    try {
      SegmentMedia.video(video, frames, 0, 1000) { false }
      SegmentMedia.wav(audio, ShortArray(16000) { (kotlin.math.sin(it * .2) * 3000).toInt().toShort() })
      val durations = mutableListOf<Long>()
      for (file in listOf(video, audio)) {
        val extractor = MediaExtractor()
        try {
          extractor.setDataSource(file.absolutePath)
          assertEquals(1, extractor.trackCount)
          durations.add(extractor.getTrackFormat(0).getLong(MediaFormat.KEY_DURATION))
          extractor.selectTrack(0)
          val buffer = ByteBuffer.allocate(320 * 240 * 4)
          var samples = 0
          do { assertTrue(extractor.readSampleData(buffer, 0) > 0); samples++ } while (extractor.advance())
          assertTrue(samples > 0)
        } finally { extractor.release() }
      }
      assertTrue("Audio/video duration difference ${durations}", abs(durations[0] - durations[1]) <= 150000)
      Log.i("UNIFIED_MEDIA", "videoUs=${durations[0]} audioUs=${durations[1]}")
    } finally { video.delete(); audio.delete() }
  }
}
