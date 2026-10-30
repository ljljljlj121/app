package expo.modules.edgeemotion

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import androidx.core.content.ContextCompat
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.UUID
import java.util.concurrent.*
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.sqrt

private data class AudioEvidence(val atMs: Long, val samples: ShortArray)
private class SpeechJob(
  val id: String, val epoch: Long, val start: Long, var end: Long,
  val settings: SpeechSettings, val directory: File
) {
  @Volatile var cancelled = false
  val cloud = CloudEmotionClient()
  val fields = mutableMapOf<String, Any?>(
    "id" to id, "startedAtMs" to start.toDouble(), "localStatus" to "recording",
    "cloudStatus" to "recording", "transcript" to "", "visualStatus" to "no_valid_frames"
  )
  val audio = ArrayList<Short>()
  val video = ArrayList<VideoEvidence>()
  val liveAsrBusy = AtomicInteger(0)
  var lastLiveAsrAt = 0L
  val visual = DoubleArray(3)
  var validFrames = 0
  val statuses = mutableMapOf<String, Int>()
  val consumers = AtomicInteger(2)
}

/** Capture never waits for finalization, ASR/text, or HTTP. Each stage is bounded. */
class SpeechCoordinator(
  private val context: Context,
  private val notify: (Map<String, Any?>) -> Unit
) {
  companion object {
    private var swept = false
    @Synchronized private fun sweepOrphans(context: Context) {
      if (swept) return
      swept = true
      // First coordinator in a process: no jobs from this process exist yet.
      context.cacheDir.listFiles()?.filter { it.isDirectory && it.name.startsWith("emotion-") }?.forEach { dir ->
        listOf("audio.wav", "video.mp4").forEach { File(dir, it).delete() }
        dir.delete()
      }
    }
  }
  init { sweepOrphans(context) }
  private val lock = Any()
  private val main = Handler(Looper.getMainLooper())
  private val audioExecutor = Executors.newSingleThreadExecutor()
  private fun executor(threads: Int, capacity: Int) = ThreadPoolExecutor(
    threads, threads, 0, TimeUnit.SECONDS, ArrayBlockingQueue(capacity), ThreadPoolExecutor.AbortPolicy())
  private val finalizer = executor(1, 2)
  private val local = executor(1, 3)
  private val cloud = executor(2, 2)
  private val admission = Semaphore(4)
  private val ringAudio = ArrayDeque<AudioEvidence>()
  private val ringVideo = ArrayDeque<VideoEvidence>()
  private val visualRing = ArrayDeque<Pair<Long, Map<String, Any?>>>()
  private val records = ArrayDeque<SpeechJob>()
  private val session = UUID.randomUUID().toString().take(8)
  private var serial = 0
  @Volatile private var epoch = 0L
  @Volatile private var active = false
  @Volatile private var disposed = false
  @Volatile private var microphone: AudioRecord? = null
  private var recording: SpeechJob? = null
  private var lastVideoAt = 0L
  private var status = "stopped"
  private var rms = 0.0
  private var engine: LocalSpeechEngine? = null
  var settings = SpeechSettings()

  fun start() {
    if (active || disposed) return
    if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
      synchronized(lock) { status = "microphone_permission_required"; emit() }; return
    }
    active = true
    val token = ++epoch
    val config = settings
    synchronized(lock) { ringAudio.clear(); ringVideo.clear(); visualRing.clear(); status = "microphone_starting"; emit() }
    audioExecutor.execute { capture(token, config) }
  }

  private fun capture(token: Long, config: SpeechSettings) {
    var recorder: AudioRecord? = null
    try {
      val minimum = AudioRecord.getMinBufferSize(16000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
      require(minimum > 0) { "16 kHz microphone is unavailable" }
      val bufferSize = maxOf(minimum * 2, 6400)
      recorder = AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, 16000,
        AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, bufferSize)
      if (recorder.state != AudioRecord.STATE_INITIALIZED) {
        recorder.release()
        recorder = AudioRecord(MediaRecorder.AudioSource.DEFAULT, 16000,
          AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, bufferSize)
      }
      check(recorder.state == AudioRecord.STATE_INITIALIZED) { "Microphone initialization failed" }
      microphone = recorder
      recorder.startRecording()
      check(recorder.recordingState == AudioRecord.RECORDSTATE_RECORDING) { "Microphone did not enter recording state" }
      synchronized(lock) { status = "listening"; emit() }
      val zero = SystemClock.elapsedRealtime()
      var sampleCount = 0L
      val buffer = ShortArray(320)
      val gate = SpeechGate(config.silenceMs)
      var voiced = 0
      var lastEmit = 0L
      while (active && token == epoch && !disposed) {
        val count = recorder.read(buffer, 0, buffer.size, AudioRecord.READ_BLOCKING)
        check(count > 0) { "Microphone read failed ($count)" }
        val at = zero + sampleCount / 16
        sampleCount += count
        val end = zero + sampleCount / 16
        val samples = buffer.copyOf(count)
        val level = sqrt(samples.sumOf { it.toDouble() * it } / count)
        voiced = if (level >= config.rms) voiced + 1 else 0
        synchronized(lock) {
          if (!active || token != epoch) return@synchronized
          rms = level
          ringAudio.addLast(AudioEvidence(at, samples))
          while (ringAudio.isNotEmpty() && at - ringAudio.first().atMs >= 500) ringAudio.removeFirst()
          val current = recording
          if (current != null) {
            // Limit by sample count too, so the WAV cannot exceed 15 seconds.
            val available = (240000 - current.audio.size).coerceAtLeast(0)
            samples.take(available).forEach { current.audio.add(it) }
            current.end = current.start + current.audio.size / 16
            if (end - current.lastLiveAsrAt >= 1000 && current.audio.size >= 16000 &&
              current.liveAsrBusy.compareAndSet(0, 1)) {
              current.lastLiveAsrAt = end
              val livePcm = current.audio.toShortArray()
              submitLiveAsr(current, livePcm)
            }
          }
          when (val outcome = gate.feed(end, if (current == null) voiced >= 3 else level >= config.rms)) {
            "start" -> {
              if (ringVideo.isEmpty()) { status = "waiting_for_video" }
              else if (!admission.tryAcquire()) {
                val rejected = SpeechJob("$session-${++serial}", token, at, end, config, File(context.cacheDir, "unused"))
                rejected.fields.putAll(mapOf("localStatus" to "queue_full", "cloudStatus" to "queue_full",
                  "endReason" to "backlog_rejected", "error" to "Processing queue is full; this utterance was not recorded"))
                records.addLast(rejected); trimRecords(); status = "queue_full_waiting_silence"
                gate.waitingSilence = true
              } else {
                val start = ringAudio.first().atMs
                val id = "$session-${++serial}"
                val job = SpeechJob(id, token, start, end, config, File(context.cacheDir, "emotion-$id"))
                ringAudio.forEach { chunk -> chunk.samples.forEach { job.audio.add(it) } }
                job.video.addAll(ringVideo.filter { it.atMs >= start - 100 })
                visualRing.filter { it.first >= start }.forEach { accumulate(job, it.second) }
                recording = job; records.addLast(job); trimRecords()
                gate.started = start; gate.lastVoice = end
                status = "recording"
              }
            }
            "natural_end", "duration_limit" -> if (current != null) {
              recording = null
              current.fields.putAll(mapOf("endReason" to outcome, "endedAtMs" to current.end.toDouble(),
                "durationMs" to (current.end - current.start).toDouble(), "localStatus" to "finalizing", "cloudStatus" to "finalizing"))
              status = if (outcome == "duration_limit") "waiting_silence" else "listening"
              submit(current)
            }
          }
          if (recording == null && !gate.waitingSilence &&
            status in listOf("waiting_silence", "queue_full_waiting_silence")) status = "listening"
          if (end - lastEmit >= 200) { emit(); lastEmit = end }
        }
      }
    } catch (error: Exception) {
      synchronized(lock) {
        if (token == epoch && active) {
          active = false
          cancelRecording("capture_interrupted")
          status = "microphone_error"
          emit(error.message)
        }
      }
    } finally {
      runCatching { recorder?.stop() }; recorder?.release()
      if (microphone === recorder) microphone = null
    }
  }

  /** Called on the existing CameraX analysis worker; no second camera owner. */
  fun frame(bitmap: Bitmap, atMs: Long) {
    if (!active || disposed || atMs - lastVideoAt < 100) return
    lastVideoAt = atMs
    val scaled = Bitmap.createBitmap(SegmentMedia.width, SegmentMedia.height, Bitmap.Config.ARGB_8888)
    val scale = minOf(SegmentMedia.width.toFloat() / bitmap.width, SegmentMedia.height.toFloat() / bitmap.height)
    val w = bitmap.width * scale; val h = bitmap.height * scale
    Canvas(scaled).drawBitmap(bitmap, null, RectF((320 - w) / 2, (240 - h) / 2, (320 + w) / 2, (240 + h) / 2),
      Paint(Paint.FILTER_BITMAP_FLAG))
    val jpeg = try { ByteArrayOutputStream().use { scaled.compress(Bitmap.CompressFormat.JPEG, 65, it); it.toByteArray() } }
      finally { if (scaled !== bitmap) scaled.recycle() }
    synchronized(lock) {
      if (!active) return
      val frame = VideoEvidence(atMs, jpeg)
      ringVideo.addLast(frame)
      while (ringVideo.isNotEmpty() && atMs - ringVideo.first().atMs > 600) ringVideo.removeFirst()
      recording?.let { if (atMs - it.start < 15000 && it.video.size < 160) it.video.add(frame) }
    }
  }

  fun visual(frame: Map<String, Any?>) = synchronized(lock) {
    if (!active || disposed) return@synchronized
    val at = (frame["analysisStartedAtMs"] as Number).toLong()
    visualRing.addLast(at to frame)
    while (visualRing.isNotEmpty() && at - visualRing.first().first > 600) visualRing.removeFirst()
    recording?.let { accumulate(it, frame) }
  }
  private fun accumulate(job: SpeechJob, frame: Map<String, Any?>) {
    val state = frame["status"] as String
    job.statuses[state] = (job.statuses[state] ?: 0) + 1
    val p = frame["probabilities"] as? List<*> ?: return
    if (state != "valid") return
    for (i in 0..2) job.visual[i] += (p[i] as Number).toDouble()
    job.validFrames++
  }
  private fun trimRecords() {
    while (records.size > 20) {
      val completed = records.firstOrNull { it !== recording && (it.consumers.get() == 0 || it.fields["endReason"] == "backlog_rejected" || it.cancelled) }
        ?: break
      records.remove(completed)
    }
  }
  private fun submit(job: SpeechJob) {
    try {
      finalizer.execute {
        var localSettled = false
        try {
          check(!job.cancelled) { "cancelled" }
          job.directory.mkdirs()
          val pcm = job.audio.toShortArray()
          job.audio.clear()
          val audio = File(job.directory, "audio.wav")
          val video = File(job.directory, "video.mp4")
          SegmentMedia.wav(audio, pcm)
          update(job, mapOf("localStatus" to "queued"))
          try { local.execute { runLocal(job, pcm) } }
          catch (_: RejectedExecutionException) { update(job, mapOf("localStatus" to "queue_full")); release(job) }
          localSettled = true
          SegmentMedia.video(video, job.video, job.start, job.end - job.start) { job.cancelled }
          job.video.clear()
          check(!job.cancelled) { "cancelled" }
          update(job, mapOf("cloudStatus" to "queued"))
          try { cloud.execute { runCloud(job, video, audio) } }
          catch (_: RejectedExecutionException) { update(job, mapOf("cloudStatus" to "queue_full")); release(job) }
        } catch (error: Exception) {
          update(job, mapOf("cloudStatus" to if (job.cancelled) "cancelled" else "media_failed", "error" to error.message))
          if (!localSettled) {
            update(job, mapOf("localStatus" to if (job.cancelled) "cancelled" else "media_failed"))
            release(job)
          }
          release(job)
        } finally { job.video.clear(); job.audio.clear() }
      }
    } catch (_: RejectedExecutionException) {
      update(job, mapOf("localStatus" to "queue_full", "cloudStatus" to "queue_full"))
      release(job); release(job)
    }
  }

  private fun submitLiveAsr(job: SpeechJob, pcm: ShortArray) {
    try {
      local.execute {
        try {
          if (!job.cancelled && active && !disposed) {
            if (engine == null) engine = LocalSpeechEngine(context)
            val text = engine!!.transcribe(pcm)
            update(job, mapOf("liveTranscript" to text, "liveAsrAtMs" to SystemClock.elapsedRealtime().toDouble()))
          }
        } catch (_: Exception) {
          // Partial ASR is diagnostic; a partial failure must not fail the segment.
        } finally {
          job.liveAsrBusy.set(0)
        }
      }
    } catch (_: RejectedExecutionException) {
      job.liveAsrBusy.set(0)
    }
  }
  private fun runLocal(job: SpeechJob, pcm: ShortArray) {
    val start = SystemClock.elapsedRealtime()
    try {
      if (job.cancelled) return
      update(job, mapOf("localStatus" to "asr"))
      if (engine == null) engine = LocalSpeechEngine(context)
      if (job.cancelled) return
      val text = engine!!.transcribe(pcm)
      val asrMs = SystemClock.elapsedRealtime() - start
      if (job.cancelled) return
      update(job, mapOf("transcript" to text, "asrMs" to asrMs.toDouble(), "localStatus" to "text"))
      val (p, chunks) = engine!!.classify(text)
      val visual = if (job.validFrames > 0) DoubleArray(3) { job.visual[it] / job.validFrames } else null
      val fused = SpeechMath.fuse(visual, p, job.settings.textWeight)
      update(job, mapOf("localStatus" to "completed", "textStatus" to if (p == null) "empty_transcript" else "valid",
        "textTag" to SpeechMath.label(p), "textProbabilities" to p?.toList(), "chunks" to chunks,
        "visualStatus" to if (visual == null) "no_valid_frames" else "valid",
        "visualTag" to SpeechMath.label(visual), "visualProbabilities" to visual?.toList(),
        "visualFrames" to job.validFrames, "visualStates" to job.statuses.toMap(),
        "fusionTag" to SpeechMath.label(fused), "fusionProbabilities" to fused?.toList(),
        "fusionMode" to if (visual == null && p == null) "unavailable" else if (visual == null) "text_only" else if (p == null) "visual_only" else "A2_F3",
        "localMs" to (SystemClock.elapsedRealtime() - start).toDouble()))
    } catch (error: Exception) {
      val visual = if (job.validFrames > 0) DoubleArray(3) { job.visual[it] / job.validFrames } else null
      update(job, mapOf("localStatus" to "failed", "localError" to error.message,
        "fusionMode" to if (visual == null) "unavailable" else "visual_only",
        "fusionTag" to SpeechMath.label(visual), "visualStates" to job.statuses.toMap()))
    } finally { release(job) }
  }
  private fun runCloud(job: SpeechJob, video: File, audio: File) {
    val start = SystemClock.elapsedRealtime()
    try {
      if (job.cancelled) return
      update(job, mapOf("cloudStatus" to "processing"))
      val tag = job.cloud.infer(video, audio, job.settings) { job.cancelled }
      update(job, mapOf("cloudStatus" to "completed", "cloudTag" to tag,
        "cloudMs" to (SystemClock.elapsedRealtime() - start).toDouble(),
        "completedAt" to System.currentTimeMillis().toDouble()))
    } catch (error: Exception) {
      update(job, mapOf("cloudStatus" to "failed", "cloudError" to error.message,
        "cloudMs" to (SystemClock.elapsedRealtime() - start).toDouble(), "completedAt" to System.currentTimeMillis().toDouble()))
    } finally { release(job) }
  }
  private fun update(job: SpeechJob, values: Map<String, Any?>) = synchronized(lock) {
    if (!disposed && !job.cancelled && job.epoch == epoch) { job.fields.putAll(values); emit() }
  }
  private fun release(job: SpeechJob) {
    if (job.consumers.decrementAndGet() == 0) {
      job.directory.listFiles()?.forEach { it.delete() }; job.directory.delete()
      admission.release()
    }
  }
  private fun cancelRecording(reason: String) {
    recording?.let {
      it.cancelled = true; it.audio.clear(); it.video.clear()
      it.fields.putAll(mapOf("endReason" to reason, "localStatus" to "cancelled", "cloudStatus" to "cancelled"))
      release(it); release(it)
    }
    recording = null
  }
  fun stop(reason: String = "user_cancelled") {
    active = false
    epoch++
    runCatching { microphone?.stop() }
    synchronized(lock) {
      cancelRecording(reason)
      records.filter { it.consumers.get() > 0 }.forEach {
        it.cancelled = true; it.cloud.cancel()
        if (it.fields["localStatus"] !in listOf("completed", "failed")) it.fields["localStatus"] = "cancelled"
        if (it.fields["cloudStatus"] !in listOf("completed", "failed", "media_failed")) it.fields["cloudStatus"] = "cancelled"
      }
      ringAudio.clear(); ringVideo.clear(); visualRing.clear()
      status = reason; emit()
    }
  }
  private fun emit(error: String? = null) {
    val token = epoch
    val value = mapOf<String, Any?>("sessionId" to session, "state" to status,
      "recordingId" to recording?.id, "rms" to rms, "rmsThreshold" to settings.rms, "error" to error,
      "records" to records.map { it.fields.toMap() })
    main.post { if (!disposed && token == epoch) notify(value) }
  }
  fun close() {
    stop("page_left"); disposed = true
    audioExecutor.shutdown()
    finalizer.shutdown(); cloud.shutdown()
    // Queued local tasks observe cancellation before the final close task.
    // A separate waiter does not occupy a bounded inference queue slot.
    local.shutdown()
    Thread {
      while (!local.awaitTermination(1, TimeUnit.SECONDS)) { /* cancelled tasks drain */ }
      engine?.close(); engine = null
    }.apply { isDaemon = true; name = "emotion-model-close"; start() }
  }
}
