package expo.modules.edgeemotion

import android.graphics.Bitmap
import com.google.mediapipe.framework.image.BitmapImageBuilder
import com.google.mediapipe.framework.image.MPImage

// MPImage owns this bitmap and recycles it on close. Keep detection and every
// pixel read (including emotion preprocessing) inside the same scope.
internal fun <T> withFrameBitmap(bitmap: Bitmap, block: (MPImage) -> T): T =
  BitmapImageBuilder(bitmap).build().use(block)
