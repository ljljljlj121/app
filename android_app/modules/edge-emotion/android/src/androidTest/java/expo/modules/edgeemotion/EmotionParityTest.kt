package expo.modules.edgeemotion

import android.graphics.BitmapFactory
import android.graphics.RectF
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.abs

@RunWith(AndroidJUnit4::class)
class EmotionParityTest {
  private val instrumentation = InstrumentationRegistry.getInstrumentation()
  private val fixtures = instrumentation.context.assets
  private fun json(name: String) = JSONArray(fixtures.open("validation/$name").bufferedReader().use { it.readText() })
  private fun tensor(name: String): FloatArray {
    val bytes = fixtures.open("validation/$name.tensor").use { it.readBytes() }
    val buffer = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).asFloatBuffer()
    return FloatArray(buffer.remaining()).also { buffer.get(it) }
  }

  @Test fun pcAndroidTensorAndFullCropParityAndDetectorShift() {
    val report = JSONObject()
    val parity = JSONArray()
    val drift = JSONArray()
    EmotionEngine(instrumentation.targetContext).use { engine ->
      for (file in listOf("cases.json", "real_crops.json")) {
        val rows = json(file)
        for (i in 0 until rows.length()) {
          val row = rows.getJSONObject(i)
          val name = row.getString("id")
          val input = tensor(name)
          val actual = engine.infer(input)
          val expected = row.getJSONArray("probability")
          val error = actual.indices.maxOf { abs(actual[it] - expected.getDouble(it)) }
          assertTrue("$name same-tensor probability error $error", error <= .001)
          val entry = JSONObject().put("id", name).put("same_tensor_probability_max_abs", error)
          if (file == "cases.json") {
            val image = fixtures.open("validation/$name.png").use { BitmapFactory.decodeStream(it) }
            val pixels = IntArray(image.width * image.height)
            image.getPixels(pixels, 0, image.width, 0, 0, image.width, image.height)
            val c = row.getJSONArray("crop")
            val output = EmotionMath.tensor(pixels, image.width, image.height, IntArray(3) { c.getInt(it) })
            val tensorError = input.indices.maxOf { abs(input[it] - output[it]) }
            val full = engine.infer(output)
            val fullError = full.indices.maxOf { abs(full[it] - expected.getDouble(it)) }
            assertTrue("$name full crop tensor error $tensorError", tensorError <= 1e-6)
            assertTrue("$name full crop probability error $fullError", fullError <= .001)
            entry.put("full_crop_tensor_max_abs", tensorError).put("full_crop_probability_max_abs", fullError)
            image.recycle()
          }
          parity.put(entry)
          Log.i("EDGE_VALIDATION", entry.toString())
        }
      }
      val rows = json("detector_cases.json")
      for (i in 0 until rows.length()) {
        val row = rows.getJSONObject(i)
        val name = row.getString("id")
        val image = fixtures.open("validation/$name.png").use { BitmapFactory.decodeStream(it) }
        val entry = JSONObject().put("id", name).put("source", row.getString("source"))
          .put("haar_boxes", row.getJSONArray("haar_boxes"))
        engine.withDetectedFaces(image) { faces ->
          assertFalse("Frame bitmap must survive until classification finishes", image.isRecycled)
          entry.put("mediapipe_boxes", JSONArray(faces.map { listOf(it.left, it.top, it.right, it.bottom) }))
          if (faces.size == 1) {
            val p = engine.classify(image, faces[0])
            entry.put("mediapipe_probability", JSONArray(p.toList()))
            if (!row.isNull("haar_probability")) {
              val reference = row.getJSONArray("haar_probability")
              entry.put("probability_max_abs_shift", p.indices.maxOf { abs(p[it] - reference.getDouble(it)) })
              entry.put("tag_agreement", p.indices.maxBy { p[it] } == (0..2).maxBy { reference.getDouble(it) })
              val boxes = row.getJSONArray("haar_boxes").getJSONArray(0)
              val haar = RectF(boxes.getDouble(0).toFloat(), boxes.getDouble(1).toFloat(),
                (boxes.getDouble(0) + boxes.getDouble(2)).toFloat(), (boxes.getDouble(1) + boxes.getDouble(3)).toFloat())
              val intersection = RectF(haar)
              val area = if (intersection.intersect(faces[0])) intersection.width() * intersection.height() else 0f
              entry.put("detector_box_iou", area / (haar.width() * haar.height() + faces[0].width() * faces[0].height() - area))
            }
          }
        }
        assertTrue("Completed MPImage scope must release its bitmap", image.isRecycled)
        drift.put(entry)
        Log.i("EDGE_DETECTOR_SHIFT", entry.toString())
      }
    }
    report.put("parity", parity).put("detector_shift", drift)
      .put("device", android.os.Build.MODEL).put("sdk", android.os.Build.VERSION.SDK_INT)
      .put("scope", "Android runtime parity and detector distribution sample check; not real-device performance acceptance")
    File(instrumentation.context.filesDir, "edge-validation.json").writeText(report.toString(2))
  }
}
