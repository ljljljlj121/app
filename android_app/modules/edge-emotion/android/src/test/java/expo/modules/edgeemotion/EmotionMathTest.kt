package expo.modules.edgeemotion

import org.junit.Assert.*
import org.junit.Test
import java.nio.ByteBuffer
import java.nio.ByteOrder

class EmotionMathTest {
  private fun bytes(name: String) = javaClass.classLoader!!.getResourceAsStream("validation/$name")!!.use { it.readBytes() }

  @Test fun pillowResizeAndPaddingMatchPc() {
    val cases = bytes("cases.tsv").toString(Charsets.UTF_8).lines()
    for (line in cases) {
      val row = line.split("\t")
      val name = row[0]
      val w = row[1].toInt()
      val h = row[2].toInt()
      val crop = row.drop(3).map { it.toInt() }.toIntArray()
      val pixelsBuffer = ByteBuffer.wrap(bytes("$name.argb")).order(ByteOrder.LITTLE_ENDIAN).asIntBuffer()
      val pixels = IntArray(w * h)
      pixelsBuffer.get(pixels)
      val reference = ByteBuffer.wrap(bytes("$name.tensor")).order(ByteOrder.LITTLE_ENDIAN).asFloatBuffer()
      val actual = EmotionMath.tensor(pixels, w, h, crop)
      var maxError = 0f
      for (value in actual) maxError = maxOf(maxError, kotlin.math.abs(value - reference.get()))
      println("$name preprocess maxAbs=$maxError")
      assertTrue("$name preprocessing error $maxError", maxError <= 1e-6f)
    }
  }

  @Test fun logitsUseTemperatureOnceAndKeepArgmax() {
    val p = EmotionMath.probabilities(floatArrayOf(-2f, 5f, 1f))
    assertEquals(1.0, p.sum(), 1e-12)
    assertEquals(1, p.indices.maxBy { p[it] })
    assertEquals(1.0 / (1.0 + kotlin.math.exp(-7 / EmotionMath.temperature) +
      kotlin.math.exp(-4 / EmotionMath.temperature)), p[1], 1e-12)
    val equal = EmotionMath.probabilities(floatArrayOf(0f, 0f, 0f))
    assertEquals(1.0 / 3, equal[0], 1e-12)
    assertEquals(listOf("positive", "negative", "neutral"), EmotionMath.labels)
  }

  @Test(expected = IllegalArgumentException::class)
  fun nonfiniteLogitsFailExplicitly() { EmotionMath.probabilities(floatArrayOf(Float.NaN, 0f, 0f)) }

  @Test fun originalCropUsesBlackPaddingAndTruncation() {
    assertArrayEquals(intArrayOf(-2, -2, 24), EmotionMath.cropBox(0f, 0f, 20f, 20f))
    val tensor = EmotionMath.tensor(intArrayOf(0xff000000.toInt()), 1, 1, intArrayOf(-1, -1, 3))
    assertEquals(-.485f / .229f, tensor[0], 1e-6f)
  }
}
