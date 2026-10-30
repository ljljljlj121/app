package expo.modules.edgeemotion

import kotlin.math.exp
import kotlin.math.max
import kotlin.math.min

object EmotionMath {
  val labels = listOf("positive", "negative", "neutral")
  const val size = 128
  const val temperature = 0.7205746494909738
  private val mean = floatArrayOf(.485f, .456f, .406f)
  private val std = floatArrayOf(.229f, .224f, .225f)

  fun probabilities(logits: FloatArray): DoubleArray {
    require(logits.size == 3 && logits.all { it.isFinite() })
    val peak = logits.max().toDouble() / temperature
    val p = DoubleArray(3) { exp(logits[it].toDouble() / temperature - peak) }
    val sum = p.sum()
    return DoubleArray(3) { p[it] / sum }
  }

  fun cropBox(x: Float, y: Float, w: Float, h: Float): IntArray {
    val side = (max(w, h) * 1.2f).toInt()
    return intArrayOf((x + w / 2 - side / 2f).toInt(), (y + h / 2 - side / 2f).toInt(), side)
  }

  // Pillow's separable antialiased BILINEAR, 22-bit coefficients and byte rounding
  // after each pass. Android Bitmap scaling uses a different downsampling kernel.
  private fun weights(input: Int, output: Int): List<Pair<Int, IntArray>> {
    val scale = input.toDouble() / output
    val support = max(1.0, scale)
    return List(output) { out ->
      val center = (out + .5) * scale
      val start = max(0, (center - support + .5).toInt())
      val end = min(input, (center + support + .5).toInt())
      val raw = DoubleArray(end - start) { max(0.0, 1 - kotlin.math.abs((it + start - center + .5) / support)) }
      val total = raw.sum()
      start to IntArray(raw.size) { (raw[it] / total * (1 shl 22) + .5).toInt() }
    }
  }

  fun tensor(pixels: IntArray, width: Int, height: Int, crop: IntArray): FloatArray {
    val (left, top, side) = crop
    require(width > 0 && height > 0 && pixels.size == width * height && side in 1..8192)
    val coeff = weights(side, size)
    val horizontal = IntArray(size * side * 3)
    for (y in 0 until side) for (ox in 0 until size) {
      val (start, ws) = coeff[ox]
      for (c in 0..2) {
        var value = 1L shl 21
        for (i in ws.indices) {
          val sx = left + start + i
          val sy = top + y
          val pixel = if (sx in 0 until width && sy in 0 until height) pixels[sy * width + sx] else 0
          value += ((pixel shr (16 - c * 8)) and 255).toLong() * ws[i]
        }
        horizontal[(y * size + ox) * 3 + c] = (value shr 22).toInt().coerceIn(0, 255)
      }
    }
    val out = FloatArray(3 * size * size)
    for (oy in 0 until size) for (x in 0 until size) {
      val (start, ws) = coeff[oy]
      for (c in 0..2) {
        var value = 1L shl 21
        for (i in ws.indices) value += horizontal[((start + i) * size + x) * 3 + c].toLong() * ws[i]
        val byte = (value shr 22).toInt().coerceIn(0, 255)
        out[c * size * size + oy * size + x] = (byte / 255f - mean[c]) / std[c]
      }
    }
    return out
  }
}
