package expo.modules.edgeemotion

import android.graphics.Bitmap
import android.graphics.Color
import com.google.mediapipe.framework.image.BitmapImageBuilder
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class FrameBitmapTest {
  private fun bitmap() = Bitmap.createBitmap(8, 8, Bitmap.Config.ARGB_8888).apply {
    eraseColor(Color.rgb(41, 83, 127))
  }

  @Test fun oldOrderingRecyclesInputBeforeClassification() {
    val bitmap = bitmap()
    BitmapImageBuilder(bitmap).build().close()
    assertTrue(bitmap.isRecycled)
  }

  @Test fun preprocessingCanReadPixelsUntilDetectionAndClassificationFinish() {
    val bitmap = bitmap()
    val probabilities = withFrameBitmap(bitmap) { image ->
      assertEquals(8, image.width)
      assertFalse(bitmap.isRecycled)
      val pixels = IntArray(64)
      bitmap.getPixels(pixels, 0, 8, 0, 0, 8, 8)
      val tensor = EmotionMath.tensor(pixels, 8, 8, intArrayOf(0, 0, 8))
      assertEquals((41f / 255 - .485f) / .229f, tensor[0], 1e-6f)
      // The ownership test exercises actual MediaPipe and Android bitmap APIs;
      // model inference itself is covered by the separate device parity test.
      EmotionMath.probabilities(floatArrayOf(1f, 2f, 3f))
    }
    assertEquals(1.0, probabilities.sum(), 1e-12)
    assertTrue(bitmap.isRecycled)
  }

  @Test fun exceptionStillReleasesFrameWithoutLeakingTheBitmap() {
    val bitmap = bitmap()
    val failure = IllegalStateException("classification failure")
    val thrown = assertThrows(IllegalStateException::class.java) {
      withFrameBitmap(bitmap) {
        assertFalse(bitmap.isRecycled)
        throw failure
      }
    }
    assertSame(failure, thrown)
    assertTrue(bitmap.isRecycled)
  }

  @Test fun noFacePathAlsoReleasesEachFrame() {
    repeat(20) {
      val bitmap = bitmap()
      val faces = withFrameBitmap(bitmap) { emptyList<Int>() }
      assertTrue(faces.isEmpty())
      assertTrue(bitmap.isRecycled)
    }
  }
}
