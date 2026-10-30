package com.robotprize.datacollection

import android.Manifest
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMuxer
import android.media.MediaRecorder
import android.os.SystemClock
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import kotlin.math.sqrt

class WavRecorderModule(context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  private val writeLock = Any()
  @Volatile private var capturing = false
  @Volatile private var latestRms = 0.0
  private var recorder: AudioRecord? = null
  private var writer: RandomAccessFile? = null
  private var worker: Thread? = null
  private var outputFile: File? = null
  private var bytesWritten = 0L
  private var startedAtMs = 0L

  override fun getName() = "WavRecorder"

  @ReactMethod
  fun startCapture(promise: Promise) {
    synchronized(writeLock) {
      if (capturing) {
        promise.reject("ALREADY_RECORDING", "麦克风正在录制")
        return
      }
      if (reactApplicationContext.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
        promise.reject("MIC_PERMISSION", "尚未获得麦克风权限")
        return
      }
      try {
        val minBuffer = AudioRecord.getMinBufferSize(SAMPLE_RATE, CHANNEL_CONFIG, AUDIO_FORMAT)
        if (minBuffer <= 0) throw IllegalStateException("设备不支持 16 kHz PCM 录音")
        val audioRecord = AudioRecord(
          MediaRecorder.AudioSource.MIC,
          SAMPLE_RATE,
          CHANNEL_CONFIG,
          AUDIO_FORMAT,
          maxOf(minBuffer * 2, SAMPLE_RATE),
        )
        if (audioRecord.state != AudioRecord.STATE_INITIALIZED) {
          audioRecord.release()
          throw IllegalStateException("无法初始化手机麦克风")
        }

        val file = File(reactApplicationContext.cacheDir, "capture-${System.currentTimeMillis()}.wav")
        val randomFile = RandomAccessFile(file, "rw")
        randomFile.setLength(0)
        randomFile.write(ByteArray(WAV_HEADER_SIZE))
        audioRecord.startRecording()

        recorder = audioRecord
        writer = randomFile
        outputFile = file
        bytesWritten = 0L
        latestRms = 0.0
        startedAtMs = SystemClock.elapsedRealtime()
        capturing = true
        worker = Thread({ captureLoop(audioRecord) }, "wav-microphone-capture").apply {
          isDaemon = true
          start()
        }
        promise.resolve(file.absolutePath)
      } catch (error: Exception) {
        capturing = false
        recorder?.release()
        recorder = null
        try { writer?.close() } catch (_: Exception) {}
        writer = null
        promise.reject("RECORD_START_FAILED", error.message ?: "麦克风启动失败", error)
      }
    }
  }

  @ReactMethod
  fun getRms(promise: Promise) {
    promise.resolve(latestRms)
  }

  @ReactMethod
  fun stopCapture(trimTailMs: Double, promise: Promise) {
    val currentRecorder = recorder
    if (currentRecorder == null || outputFile == null) {
      promise.reject("NOT_RECORDING", "当前没有麦克风录制")
      return
    }

    capturing = false
    try { currentRecorder.stop() } catch (_: IllegalStateException) {}
    try { worker?.join(1500) } catch (_: InterruptedException) { Thread.currentThread().interrupt() }
    currentRecorder.release()
    recorder = null
    worker = null

    try {
      val finishedFile = outputFile ?: throw IllegalStateException("录音文件不存在")
      var pcmBytes = 0L
      var trimmedBytes = 0L
      synchronized(writeLock) {
        val fileWriter = writer ?: throw IllegalStateException("录音文件未打开")
        trimmedBytes = tailTrimBytes(bytesWritten, trimTailMs)
        pcmBytes = (bytesWritten - trimmedBytes).coerceAtLeast(0L).coerceAtMost(0xFFFFFFFFL - 36L)
        fileWriter.setLength(WAV_HEADER_SIZE + pcmBytes)
        fileWriter.seek(0)
        writeHeader(fileWriter, pcmBytes.toInt())
        fileWriter.fd.sync()
        fileWriter.close()
        writer = null
      }
      val result = Arguments.createMap().apply {
        putString("path", finishedFile.absolutePath)
        putDouble("durationMs", pcmBytes * 1000.0 / (SAMPLE_RATE * 2))
        putDouble("trimmedTailMs", trimmedBytes * 1000.0 / (SAMPLE_RATE * 2))
      }
      outputFile = null
      promise.resolve(result)
    } catch (error: Exception) {
      try { writer?.close() } catch (_: Exception) {}
      writer = null
      outputFile = null
      promise.reject("RECORD_STOP_FAILED", error.message ?: "麦克风录音保存失败", error)
    }
  }

  private fun tailTrimBytes(pcmBytes: Long, requestedMs: Double): Long {
    val requestedBytes = (requestedMs.coerceAtLeast(0.0) * SAMPLE_RATE * 2 / 1000.0).toLong() and -2L
    // 仅限制文件边界，防止异常输入生成空 WAV；不再检查音量。
    val maximumTrimBytes = (pcmBytes - SAMPLE_RATE).coerceAtLeast(0L) and -2L
    return minOf(requestedBytes, maximumTrimBytes)
  }

  @ReactMethod
  fun trimVideoTail(videoPath: String, trimTailMs: Double, promise: Promise) {
    Thread({
      val extractor = MediaExtractor()
      var muxer: MediaMuxer? = null
      var started = false
      val output = File(reactApplicationContext.cacheDir, "trimmed-video-${System.currentTimeMillis()}.mp4")
      try {
        extractor.setDataSource(localFile(videoPath).absolutePath)
        val track = (0 until extractor.trackCount).firstOrNull {
          extractor.getTrackFormat(it).getString(MediaFormat.KEY_MIME)?.startsWith("video/") == true
        } ?: throw IllegalStateException("录制文件中没有视频轨道")
        val format = extractor.getTrackFormat(track)
        val durationUs = if (format.containsKey(MediaFormat.KEY_DURATION)) {
          format.getLong(MediaFormat.KEY_DURATION)
        } else {
          estimateVideoDurationUs(extractor, track)
        }
        val endUs = (durationUs - (trimTailMs.coerceAtLeast(0.0) * 1000).toLong()).coerceAtLeast(1_000_000L)
        val videoMuxer = MediaMuxer(output.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
        muxer = videoMuxer
        if (format.containsKey(MediaFormat.KEY_ROTATION)) videoMuxer.setOrientationHint(format.getInteger(MediaFormat.KEY_ROTATION))
        val outputTrack = videoMuxer.addTrack(format)
        videoMuxer.start()
        started = true
        extractor.selectTrack(track)
        val maxSize = if (format.containsKey(MediaFormat.KEY_MAX_INPUT_SIZE)) format.getInteger(MediaFormat.KEY_MAX_INPUT_SIZE) else 0
        val buffer = ByteBuffer.allocateDirect(maxOf(maxSize, 4 * 1024 * 1024))
        val info = MediaCodec.BufferInfo()
        while (extractor.sampleTime >= 0 && extractor.sampleTime < endUs) {
          buffer.clear()
          val size = extractor.readSampleData(buffer, 0)
          if (size < 0) break
          info.set(0, size, extractor.sampleTime, extractor.sampleFlags)
          videoMuxer.writeSampleData(outputTrack, buffer, info)
          if (!extractor.advance()) break
        }
        videoMuxer.stop()
        started = false
        promise.resolve(output.absolutePath)
      } catch (error: Exception) {
        output.delete()
        promise.reject("VIDEO_TRIM_FAILED", error.message ?: "视频尾部裁切失败", error)
      } finally {
        if (started) try { muxer?.stop() } catch (_: Exception) {}
        try { muxer?.release() } catch (_: Exception) {}
        extractor.release()
      }
    }, "video-tail-trim").apply { isDaemon = true; start() }
  }

  @ReactMethod
  fun createSilentWav(durationMs: Double, promise: Promise) {
    try {
      val safeDurationMs = durationMs.coerceIn(0.0, 60_000.0)
      val pcmLength = ((safeDurationMs * SAMPLE_RATE * 2 / 1000.0).toLong() and -2L).toInt()
      val file = File(reactApplicationContext.cacheDir, "silence-${System.currentTimeMillis()}.wav")
      RandomAccessFile(file, "rw").use { wav ->
        writeHeader(wav, pcmLength)
        wav.seek(WAV_HEADER_SIZE.toLong())
        val silence = ByteArray(BUFFER_SIZE)
        var remaining = pcmLength
        while (remaining > 0) {
          val count = minOf(silence.size, remaining)
          wav.write(silence, 0, count)
          remaining -= count
        }
      }
      promise.resolve(file.absolutePath)
    } catch (error: Exception) {
      promise.reject("SILENT_WAV_FAILED", error.message ?: "静音 WAV 创建失败", error)
    }
  }

  @ReactMethod
  fun mergeMedia(videoPath: String, wavPath: String, audioOffsetSeconds: Double, promise: Promise) {
    Thread({
      try {
        val output = mergeVideoAndAudio(
          localFile(videoPath),
          localFile(wavPath),
          audioOffsetSeconds.coerceIn(-5.0, 5.0),
        )
        promise.resolve(output.absolutePath)
      } catch (error: Exception) {
        promise.reject("MEDIA_MERGE_FAILED", error.message ?: "音视频合成失败", error)
      }
    }, "media-muxer").apply {
      isDaemon = true
      start()
    }
  }

  @ReactMethod
  fun deleteFile(path: String, promise: Promise) {
    try {
      val cache = reactApplicationContext.cacheDir.canonicalFile
      val target = localFile(path).canonicalFile
      if (target.path != cache.path && !target.path.startsWith(cache.path + File.separator)) {
        promise.reject("DELETE_OUTSIDE_CACHE", "仅允许清理应用缓存中的临时采集文件")
        return
      }
      if (target.exists()) target.delete()
      promise.resolve(null)
    } catch (error: Exception) {
      promise.reject("DELETE_FAILED", error.message ?: "临时文件清理失败", error)
    }
  }

  private fun mergeVideoAndAudio(videoFile: File, wavFile: File, offsetSeconds: Double): File {
    if (!videoFile.isFile || !wavFile.isFile || wavFile.length() <= WAV_HEADER_SIZE) {
      throw IllegalArgumentException("录制视频或 WAV 音频文件不存在/为空")
    }
    val encodedAudio = encodeWavAsAac(wavFile)
    val extractor = MediaExtractor()
    var muxer: MediaMuxer? = null
    var muxerStarted = false
    var outputFile: File? = null
    try {
      extractor.setDataSource(videoFile.absolutePath)
      val videoTrack = (0 until extractor.trackCount).firstOrNull { index ->
        extractor.getTrackFormat(index).getString(MediaFormat.KEY_MIME)?.startsWith("video/") == true
      } ?: throw IllegalStateException("录制文件中没有视频轨道")
      val videoFormat = extractor.getTrackFormat(videoTrack)
      val videoDurationUs = if (videoFormat.containsKey(MediaFormat.KEY_DURATION)) {
        videoFormat.getLong(MediaFormat.KEY_DURATION)
      } else {
        estimateVideoDurationUs(extractor, videoTrack)
      }
      val wavDurationUs = (wavFile.length() - WAV_HEADER_SIZE) * 1_000_000L / (SAMPLE_RATE * 2L)
      val offsetUs = (offsetSeconds * 1_000_000.0).toLong()
      val videoShiftUs = maxOf(0L, -offsetUs)
      val audioShiftUs = maxOf(0L, offsetUs)
      // 保留两条轨道的完整尾部，短轨道不能截断另一条轨道。
      val timelineEndUs = maxOf(videoDurationUs + videoShiftUs, wavDurationUs + audioShiftUs)
      if (timelineEndUs <= 0) throw IllegalStateException("音视频有效时长为 0")

      val merged = File(reactApplicationContext.cacheDir, "merged-${System.currentTimeMillis()}.mp4")
      outputFile = merged
      muxer = MediaMuxer(merged.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
      if (videoFormat.containsKey(MediaFormat.KEY_ROTATION)) {
        muxer.setOrientationHint(videoFormat.getInteger(MediaFormat.KEY_ROTATION))
      }
      val muxVideoTrack = muxer.addTrack(videoFormat)
      val muxAudioTrack = muxer.addTrack(encodedAudio.format)
      muxer.start()
      muxerStarted = true

      extractor.selectTrack(videoTrack)
      val maxSampleSize = if (videoFormat.containsKey(MediaFormat.KEY_MAX_INPUT_SIZE)) {
        videoFormat.getInteger(MediaFormat.KEY_MAX_INPUT_SIZE).coerceAtLeast(1024 * 1024)
      } else {
        4 * 1024 * 1024
      }
      val sampleBuffer = ByteBuffer.allocateDirect(maxSampleSize)
      val sampleInfo = MediaCodec.BufferInfo()
      while (true) {
        val sampleTimeUs = extractor.sampleTime
        if (sampleTimeUs < 0) break
        val shiftedTimeUs = sampleTimeUs + videoShiftUs
        if (shiftedTimeUs > timelineEndUs) break
        sampleBuffer.clear()
        val size = extractor.readSampleData(sampleBuffer, 0)
        if (size < 0) break
        sampleInfo.set(0, size, shiftedTimeUs, extractor.sampleFlags)
        muxer.writeSampleData(muxVideoTrack, sampleBuffer, sampleInfo)
        if (!extractor.advance()) break
      }

      for (sample in encodedAudio.samples) {
        val shiftedTimeUs = sample.presentationTimeUs + audioShiftUs
        if (shiftedTimeUs > timelineEndUs) break
        val bytes = ByteBuffer.wrap(sample.data)
        sampleInfo.set(0, sample.data.size, shiftedTimeUs, 0)
        muxer.writeSampleData(muxAudioTrack, bytes, sampleInfo)
      }
      return merged
    } catch (error: Exception) {
      outputFile?.delete()
      throw error
    } finally {
      if (muxerStarted) {
        try { muxer?.stop() } catch (_: Exception) {}
      }
      try { muxer?.release() } catch (_: Exception) {}
      try { extractor.release() } catch (_: Exception) {}
    }
  }

  private fun estimateVideoDurationUs(extractor: MediaExtractor, trackIndex: Int): Long {
    extractor.selectTrack(trackIndex)
    var lastTimeUs = 0L
    while (extractor.sampleTime >= 0) {
      lastTimeUs = extractor.sampleTime
      if (!extractor.advance()) break
    }
    extractor.unselectTrack(trackIndex)
    extractor.seekTo(0, MediaExtractor.SEEK_TO_CLOSEST_SYNC)
    return lastTimeUs.coerceAtLeast(1L)
  }

  private fun encodeWavAsAac(wavFile: File): EncodedAudio {
    val encoderFormat = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, SAMPLE_RATE, 1).apply {
      setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
      setInteger(MediaFormat.KEY_BIT_RATE, 96_000)
      setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, BUFFER_SIZE)
    }
    val encoder = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC)
    val samples = ArrayList<EncodedSample>()
    var outputFormat: MediaFormat? = null
    val pcm = RandomAccessFile(wavFile, "r")
    val input = ByteArray(BUFFER_SIZE)
    var inputDone = false
    var outputDone = false
    var bytesQueued = 0L
    try {
      pcm.seek(WAV_HEADER_SIZE.toLong())
      encoder.configure(encoderFormat, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
      encoder.start()
      val info = MediaCodec.BufferInfo()
      while (!outputDone) {
        if (!inputDone) {
          val inputIndex = encoder.dequeueInputBuffer(10_000)
          if (inputIndex >= 0) {
            val inputBuffer = encoder.getInputBuffer(inputIndex)
              ?: throw IllegalStateException("AAC 编码器没有可写缓冲区")
            inputBuffer.clear()
            val wanted = minOf(input.size, inputBuffer.remaining())
            val count = if (bytesQueued < wavFile.length() - WAV_HEADER_SIZE) {
              pcm.read(input, 0, minOf(wanted.toLong(), wavFile.length() - WAV_HEADER_SIZE - bytesQueued).toInt())
            } else {
              -1
            }
            if (count > 0) {
              inputBuffer.put(input, 0, count)
              val pts = bytesQueued * 1_000_000L / (SAMPLE_RATE * 2L)
              encoder.queueInputBuffer(inputIndex, 0, count, pts, 0)
              bytesQueued += count
            } else {
              val pts = bytesQueued * 1_000_000L / (SAMPLE_RATE * 2L)
              encoder.queueInputBuffer(inputIndex, 0, 0, pts, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
              inputDone = true
            }
          }
        }

        val outputIndex = encoder.dequeueOutputBuffer(info, 10_000)
        when {
          outputIndex == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> outputFormat = encoder.outputFormat
          outputIndex >= 0 -> {
            if (info.size > 0 && (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) == 0) {
              val outputBuffer = encoder.getOutputBuffer(outputIndex)
                ?: throw IllegalStateException("AAC 编码器没有可读缓冲区")
              val copy = outputBuffer.duplicate()
              copy.position(info.offset)
              copy.limit(info.offset + info.size)
              val data = ByteArray(info.size)
              copy.get(data)
              samples.add(EncodedSample(data, info.presentationTimeUs, info.flags))
            }
            if ((info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) outputDone = true
            encoder.releaseOutputBuffer(outputIndex, false)
          }
        }
      }
    } finally {
      try { pcm.close() } catch (_: Exception) {}
      try { encoder.stop() } catch (_: Exception) {}
      encoder.release()
    }
    val format = outputFormat ?: throw IllegalStateException("AAC 音频编码失败")
    if (samples.isEmpty()) throw IllegalStateException("AAC 音频数据为空")
    return EncodedAudio(format, samples)
  }

  private fun localFile(path: String): File {
    val cleanPath = if (path.startsWith("file://")) path.removePrefix("file://") else path
    return File(cleanPath)
  }

  private data class EncodedAudio(val format: MediaFormat, val samples: List<EncodedSample>)
  private data class EncodedSample(val data: ByteArray, val presentationTimeUs: Long, val flags: Int)

  private fun captureLoop(audioRecord: AudioRecord) {
    val buffer = ByteArray(BUFFER_SIZE)
    while (capturing) {
      val count = audioRecord.read(buffer, 0, buffer.size, AudioRecord.READ_BLOCKING)
      if (count <= 0) continue
      var sumSquares = 0.0
      var sampleCount = 0
      var index = 0
      while (index + 1 < count) {
        val sample = ((buffer[index + 1].toInt() shl 8) or (buffer[index].toInt() and 0xFF)).toShort().toInt()
        sumSquares += sample.toDouble() * sample.toDouble()
        sampleCount++
        index += 2
      }
      latestRms = if (sampleCount == 0) 0.0 else sqrt(sumSquares / sampleCount)
      synchronized(writeLock) {
        try {
          writer?.write(buffer, 0, count)
          bytesWritten += count
        } catch (_: Exception) {
          capturing = false
        }
      }
    }
  }

  private fun writeHeader(file: RandomAccessFile, pcmBytes: Int) {
    file.writeBytes("RIFF")
    writeIntLe(file, pcmBytes + 36)
    file.writeBytes("WAVE")
    file.writeBytes("fmt ")
    writeIntLe(file, 16)
    writeShortLe(file, 1)
    writeShortLe(file, 1)
    writeIntLe(file, SAMPLE_RATE)
    writeIntLe(file, SAMPLE_RATE * 2)
    writeShortLe(file, 2)
    writeShortLe(file, 16)
    file.writeBytes("data")
    writeIntLe(file, pcmBytes)
  }

  private fun writeIntLe(file: RandomAccessFile, value: Int) {
    file.write(value and 0xFF)
    file.write((value ushr 8) and 0xFF)
    file.write((value ushr 16) and 0xFF)
    file.write((value ushr 24) and 0xFF)
  }

  private fun writeShortLe(file: RandomAccessFile, value: Int) {
    file.write(value and 0xFF)
    file.write((value ushr 8) and 0xFF)
  }

  companion object {
    private const val SAMPLE_RATE = 16_000
    private const val CHANNEL_CONFIG = AudioFormat.CHANNEL_IN_MONO
    private const val AUDIO_FORMAT = AudioFormat.ENCODING_PCM_16BIT
    private const val WAV_HEADER_SIZE = 44
    private const val BUFFER_SIZE = 4_096
  }
}
