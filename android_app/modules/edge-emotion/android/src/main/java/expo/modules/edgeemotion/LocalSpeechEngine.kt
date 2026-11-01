package expo.modules.edgeemotion

import android.content.Context
import ai.onnxruntime.*
import com.k2fsa.sherpa.onnx.*
import java.io.File
import java.nio.LongBuffer

/** One resident ASR and classifier, used exclusively by the local inference executor. */
class LocalSpeechEngine(private val context: Context) : AutoCloseable {
  private val recognizer = OfflineRecognizer(
    assetManager = context.assets,
    config = OfflineRecognizerConfig(
      featConfig = FeatureConfig(sampleRate = 16000, featureDim = 80),
      modelConfig = OfflineModelConfig(
        paraformer = OfflineParaformerModelConfig(model = "offline_asr/model.int8.onnx"),
        tokens = "offline_asr/tokens.txt", numThreads = 2, provider = "cpu",
        modelType = "paraformer"
      ), decodingMethod = "greedy_search"
    )
  )
  private val env = OrtEnvironment.getEnvironment()
  private val tokenizer = BertTokens(context.assets.open("text_emotion/vocab.txt").bufferedReader().use { it.readLines() })
  private val classifier: OrtSession
  init {
    val target = File(context.noBackupFilesDir, "text-600ec556.onnx")
    if (!target.exists() || target.length() != 153953157L) {
      context.assets.open("text_emotion/model.onnx").use { input -> target.outputStream().use { input.copyTo(it) } }
    }
    classifier = OrtSession.SessionOptions().use {
      it.setIntraOpNumThreads(2); it.setInterOpNumThreads(1)
      env.createSession(target.absolutePath, it)
    }
  }
  fun transcribe(pcm: ShortArray): String {
    val stream = recognizer.createStream()
    try {
      stream.acceptWaveform(FloatArray(pcm.size) { pcm[it] / 32768f }, 16000)
      recognizer.decode(stream)
      return recognizer.getResult(stream).text.trim()
    } finally { stream.release() }
  }
  fun classify(text: String): Pair<DoubleArray?, Int> {
    val chunks = tokenizer.chunks(text)
    if (chunks.isEmpty()) return null to 0
    val accumulated = DoubleArray(3)
    var total = 0
    for (chunk in chunks) {
      if (Thread.currentThread().isInterrupted) throw InterruptedException()
      val ids = LongArray(64)
      ids[0] = 101; chunk.forEachIndexed { i, token -> ids[i + 1] = token }; ids[chunk.size + 1] = 102
      val mask = LongArray(64) { if (it < chunk.size + 2) 1 else 0 }
      val shape = longArrayOf(1, 64)
      val tensors = mutableMapOf<String, OnnxTensor>()
      try {
        tensors["input_ids"] = OnnxTensor.createTensor(env, LongBuffer.wrap(ids), shape)
        tensors["attention_mask"] = OnnxTensor.createTensor(env, LongBuffer.wrap(mask), shape)
        if ("token_type_ids" in classifier.inputNames)
          tensors["token_type_ids"] = OnnxTensor.createTensor(env, LongBuffer.wrap(LongArray(64)), shape)
        classifier.run(tensors).use { result ->
          @Suppress("UNCHECKED_CAST")
          val logits = (result[0].value as Array<FloatArray>)[0]
          val p = SpeechMath.softmax(logits)
          for (i in 0..2) accumulated[i] += p[i] * chunk.size
          total += chunk.size
        }
      } finally { tensors.values.forEach { it.close() } }
    }
    return DoubleArray(3) { accumulated[it] / total } to chunks.size
  }
  override fun close() { classifier.close(); recognizer.release() }
}
