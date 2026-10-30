package expo.modules.edgeemotion

import android.content.Context
import android.graphics.Bitmap
import android.graphics.RectF
import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import com.google.mediapipe.tasks.core.BaseOptions
import com.google.mediapipe.tasks.vision.core.RunningMode
import com.google.mediapipe.tasks.vision.facedetector.FaceDetector
import java.nio.FloatBuffer
import java.security.MessageDigest
import org.json.JSONObject

class EmotionEngine(context: Context) : AutoCloseable {
  private val assets = context.assets
  private val manifest = JSONObject(assets.open("edge_emotion/manifest.json").bufferedReader().use { it.readText() })
  private val env = OrtEnvironment.getEnvironment()
  private val session: OrtSession
  private val detector: FaceDetector

  init {
    val bytes = assets.open("edge_emotion/model.onnx").use { it.readBytes() }
    fun hash(data: ByteArray) = MessageDigest.getInstance("SHA-256").digest(data).joinToString("") { "%02x".format(it) }
    check(hash(bytes) == manifest.getString("onnx_sha256")) { "Emotion model checksum mismatch" }
    val detectionBytes = assets.open("edge_emotion/face_detector.tflite").use { it.readBytes() }
    check(hash(detectionBytes) == manifest.getString("detector_sha256")) { "Face detector checksum mismatch" }
    session = OrtSession.SessionOptions().use { options ->
      options.setIntraOpNumThreads(2)
      options.setInterOpNumThreads(1)
      env.createSession(bytes, options)
    }
    try {
      detector = FaceDetector.createFromOptions(context, FaceDetector.FaceDetectorOptions.builder()
        .setBaseOptions(BaseOptions.builder().setModelAssetPath("edge_emotion/face_detector.tflite").build())
        .setRunningMode(RunningMode.IMAGE).setMinDetectionConfidence(.5f).build())
    } catch (error: Throwable) {
      session.close()
      throw error
    }
  }

  // Consumes bitmap. The callback must finish classification before MPImage closes.
  fun <T> withDetectedFaces(bitmap: Bitmap, block: (List<RectF>) -> T): T =
    withFrameBitmap(bitmap) { image ->
      block(detector.detect(image).detections().map { RectF(it.boundingBox()) })
    }

  fun infer(tensor: FloatArray): DoubleArray =
    OnnxTensor.createTensor(env, FloatBuffer.wrap(tensor), longArrayOf(1, 3, 128, 128)).use { input ->
      session.run(mapOf(session.inputNames.first() to input)).use { result ->
        @Suppress("UNCHECKED_CAST")
        val logits = (result[0].value as Array<FloatArray>)[0]
        EmotionMath.probabilities(logits)
      }
    }

  fun classify(bitmap: Bitmap, box: RectF): DoubleArray {
    check(!bitmap.isRecycled) { "Emotion preprocessing received a recycled bitmap" }
    val crop = EmotionMath.cropBox(box.left, box.top, box.width(), box.height())
    val pixels = IntArray(bitmap.width * bitmap.height)
    bitmap.getPixels(pixels, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height)
    return infer(EmotionMath.tensor(pixels, bitmap.width, bitmap.height, crop))
  }

  override fun close() { try { detector.close() } finally { session.close() } }
}
