package expo.modules.edgeemotion

import android.graphics.BitmapFactory
import android.media.*
import java.io.File
import java.io.RandomAccessFile

data class VideoEvidence(val atMs: Long, val jpeg: ByteArray)

object SegmentMedia {
  const val width = 320
  const val height = 240
  fun wav(file: File, pcm: ShortArray) {
    RandomAccessFile(file, "rw").use { out ->
      out.setLength(0)
      fun int(value: Int) { out.writeInt(Integer.reverseBytes(value)) }
      fun short(value: Int) { out.writeShort(java.lang.Short.reverseBytes(value.toShort()).toInt()) }
      out.writeBytes("RIFF"); int(36 + pcm.size * 2); out.writeBytes("WAVEfmt ")
      int(16); short(1); short(1); int(16000); int(32000); short(2); short(16)
      out.writeBytes("data"); int(pcm.size * 2)
      pcm.forEach { short(it.toInt()) }
    }
  }
  /** Video-only MP4 and WAV deliberately share the same zero point and duration. */
  fun video(file: File, frames: List<VideoEvidence>, startMs: Long, durationMs: Long, cancelled: () -> Boolean) {
    require(frames.isNotEmpty()) { "No video frames for this segment" }
    val codec = MediaCodec.createEncoderByType("video/avc")
    var muxer: MediaMuxer? = null
    var muxerStarted = false
    var codecStarted = false
    try {
      val format = MediaFormat.createVideoFormat("video/avc", width, height).apply {
        setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatYUV420Flexible)
        setInteger(MediaFormat.KEY_BIT_RATE, 400000)
        setInteger(MediaFormat.KEY_FRAME_RATE, 10)
        setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1)
      }
      codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
      codec.start(); codecStarted = true
      val output = MediaMuxer(file.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
      muxer = output
      val info = MediaCodec.BufferInfo()
      var track = -1
      var input = 0
      var eos = false
      var done = false
      val deadline = android.os.SystemClock.elapsedRealtime() + 30000
      // Resample captured CameraX evidence at 10 FPS; repeat the nearest previous
      // frame across analysis gaps rather than shorten the audio time range.
      val count = ((durationMs + 99) / 100).toInt().coerceAtLeast(1)
      var source = 0
      while (!done) {
        check(!cancelled()) { "cancelled" }
        check(android.os.SystemClock.elapsedRealtime() < deadline) { "Video encoder timeout" }
        if (!eos) {
          val index = codec.dequeueInputBuffer(10000)
          if (index >= 0) {
            if (input == count) {
              codec.queueInputBuffer(index, 0, 0, durationMs * 1000, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
              eos = true
            } else {
              val at = startMs + input * 100L
              while (source + 1 < frames.size && frames[source + 1].atMs <= at) source++
              val bitmap = BitmapFactory.decodeByteArray(frames[source].jpeg, 0, frames[source].jpeg.size)
                ?: error("Cannot decode captured frame")
              val pixels = IntArray(width * height)
              try { bitmap.getPixels(pixels, 0, width, 0, 0, width, height) } finally { bitmap.recycle() }
              val image = codec.getInputImage(index) ?: error("Encoder has no YUV input image")
              for (y in 0 until height) for (x in 0 until width) {
                val color = pixels[y * width + x]
                val r = color shr 16 and 255; val g = color shr 8 and 255; val b = color and 255
                fun put(plane: Int, px: Int, py: Int, value: Int) {
                  val p = image.planes[plane]
                  p.buffer.put(py * p.rowStride + px * p.pixelStride, value.coerceIn(0, 255).toByte())
                }
                put(0, x, y, ((66 * r + 129 * g + 25 * b + 128) shr 8) + 16)
                if (x % 2 == 0 && y % 2 == 0) {
                  put(1, x / 2, y / 2, ((-38 * r - 74 * g + 112 * b + 128) shr 8) + 128)
                  put(2, x / 2, y / 2, ((112 * r - 94 * g - 18 * b + 128) shr 8) + 128)
                }
              }
              codec.queueInputBuffer(index, 0, width * height * 3 / 2, input * 100000L, 0)
              input++
            }
          }
        }
        when (val index = codec.dequeueOutputBuffer(info, 10000)) {
          MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
            check(!muxerStarted)
            track = output.addTrack(codec.outputFormat); output.start(); muxerStarted = true
          }
          else -> if (index >= 0) {
            if (info.size > 0 && info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG == 0) {
              check(muxerStarted)
              val buffer = codec.getOutputBuffer(index)!!
              buffer.position(info.offset); buffer.limit(info.offset + info.size)
              output.writeSampleData(track, buffer, info)
            }
            done = info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0
            codec.releaseOutputBuffer(index, false)
          }
        }
      }
      output.stop(); muxerStarted = false
    } finally {
      if (codecStarted) runCatching { codec.stop() }
      codec.release()
      if (muxerStarted) runCatching { muxer?.stop() }
      muxer?.release()
    }
    val extractor = MediaExtractor()
    try {
      extractor.setDataSource(file.absolutePath)
      require(extractor.trackCount == 1 && extractor.getTrackFormat(0).getString(MediaFormat.KEY_MIME)?.startsWith("video/") == true)
      extractor.selectTrack(0)
      require(extractor.sampleTime >= 0 && extractor.sampleSize > 0) { "Empty video" }
    } finally { extractor.release() }
  }
}
