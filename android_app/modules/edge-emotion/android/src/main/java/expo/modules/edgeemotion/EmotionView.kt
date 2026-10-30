package expo.modules.edgeemotion

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.*
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CaptureRequest
import android.hardware.camera2.TotalCaptureResult
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Size
import android.util.Log
import android.view.OrientationEventListener
import android.view.Surface
import android.view.View
import android.widget.FrameLayout
import androidx.camera.camera2.interop.Camera2CameraInfo
import androidx.camera.camera2.interop.Camera2Interop
import androidx.camera.core.*
import androidx.camera.core.resolutionselector.*
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.camera.view.transform.CoordinateTransform
import androidx.camera.view.transform.ImageProxyTransformFactory
import androidx.camera.view.transform.OutputTransform
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.Observer
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicLong

@Suppress("ViewConstructor")
class EmotionView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  // PreviewView adds its TextureView after CameraX requests a surface. React Native
  // does not perform that child's subsequent Android measure/layout by default.
  override val shouldUseAndroidLayout = true
  val onFrames by EventDispatcher<Map<String, Any?>>()
  var paused = false
  var front = true
  var acknowledged = ""
  private val main = Handler(Looper.getMainLooper())
  private val worker = Executors.newSingleThreadExecutor()
  private val preview = PreviewView(context).apply {
    implementationMode = PreviewView.ImplementationMode.COMPATIBLE
    scaleType = PreviewView.ScaleType.FILL_CENTER
  }
  private val overlay = FaceOverlay(context)
  private val container = FrameLayout(context)
  private val activity get() = appContext.currentActivity
  private var owner: LifecycleOwner? = null
  private var provider: ProcessCameraProvider? = null
  private var analysis: ImageAnalysis? = null
  private var previewUseCase: Preview? = null
  private var cameraInfo: CameraInfo? = null
  private var cameraObserver: Observer<CameraState>? = null
  private var engine: EmotionEngine? = null // accessed only on worker
  @Volatile private var disposed = false
  private var foreground = true
  private var running = false
  private var boundFront = true
  @Volatile private var generation = 0L
  private var sequence = 0L
  private var sessionStarted = 0L
  private var analyzed = 0L
  private val captured = AtomicLong()
  private var realtimeTimestamps = false
  private val history = ArrayDeque<Map<String, Any?>>()
  private var current: Map<String, Any?>? = null
  private var state = "initializing"
  private var detail: String? = null
  private var lastResultAt = 0L
  private var freezeAt = 0L
  private var lastFailureSignature: String? = null
  private var lastFailureLogAt = 0L
  private val orientation = object : OrientationEventListener(context) {
    override fun onOrientationChanged(value: Int) {
      if (value == ORIENTATION_UNKNOWN) return
      val rotation = when (value) {
        in 45..134 -> Surface.ROTATION_270
        in 135..224 -> Surface.ROTATION_180
        in 225..314 -> Surface.ROTATION_90
        else -> Surface.ROTATION_0
      }
      if (analysis?.targetRotation != rotation) {
        analysis?.targetRotation = rotation
        previewUseCase?.targetRotation = rotation
        overlay.box = null
        overlay.invalidate()
      }
    }
  }
  private val ticker = object : Runnable {
    override fun run() {
      if (disposed) return
      val now = SystemClock.elapsedRealtime()
      if (running && state != "camera_recovering" && lastResultAt > 0 && now - lastResultAt > 450) {
        current = null
        overlay.box = null
        overlay.invalidate()
        state = "waiting"
      }
      emit(emptyList())
      main.postDelayed(this, 100)
    }
  }

  init {
    container.addView(preview, FrameLayout.LayoutParams(-1, -1))
    container.addView(overlay, FrameLayout.LayoutParams(-1, -1))
    addView(container, LayoutParams(-1, -1))
    main.post(ticker)
  }

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    container.measure(
      MeasureSpec.makeMeasureSpec(right - left, MeasureSpec.EXACTLY),
      MeasureSpec.makeMeasureSpec(bottom - top, MeasureSpec.EXACTLY)
    )
    container.layout(0, 0, right - left, bottom - top)
    if (changed && state == "initializing" && !running && !disposed) post { update() }
  }

  override fun onAttachedToWindow() { super.onAttachedToWindow(); update() }
  override fun onDetachedFromWindow() { dispose(); super.onDetachedFromWindow() }
  override fun onWindowVisibilityChanged(visibility: Int) {
    super.onWindowVisibilityChanged(visibility)
    foreground = visibility == View.VISIBLE
    if (foreground) update() else stop("background")
  }

  fun update() {
    if (disposed || !isAttachedToWindow || width == 0 || height == 0) return
    if (owner == null) {
      owner = activity as? LifecycleOwner
    }
    if (paused || !foreground) {
      if (running) stop(if (paused) "paused" else "background")
      return
    }
    if (running && boundFront == front) return
    if (running) stop("switching")
    generation++
    val token = generation
    history.clear()
    current = null
    overlay.box = null
    overlay.invalidate()
    detail = null
    state = "initializing"
    freezeAt = 0
    sequence = 0
    analyzed = 0
    captured.set(0)
    lastResultAt = 0
    sessionStarted = SystemClock.elapsedRealtime()
    boundFront = front
    running = true
    emit(emptyList())
    if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
      fail("permission_denied", "Camera permission is required")
      return
    }
    worker.execute {
      try {
        if (engine == null) engine = EmotionEngine(context)
        main.post { if (!disposed && running && generation == token) bind(token) }
      } catch (error: Exception) {
        main.post { if (generation == token && !disposed) fail("model_error", error.message) }
      }
    }
  }

  private fun bind(token: Long) {
    val future = ProcessCameraProvider.getInstance(context)
    future.addListener({
      if (disposed || !running || token != generation) return@addListener
      try {
        val cameraProvider = future.get()
        provider = cameraProvider
        val selector = CameraSelector.Builder().requireLensFacing(
          if (boundFront) CameraSelector.LENS_FACING_FRONT else CameraSelector.LENS_FACING_BACK).build()
        check(cameraProvider.hasCamera(selector)) { "Requested camera unavailable" }
        val resolution = ResolutionSelector.Builder()
          .setAspectRatioStrategy(AspectRatioStrategy.RATIO_4_3_FALLBACK_AUTO_STRATEGY)
          .setResolutionStrategy(ResolutionStrategy(Size(640, 480), ResolutionStrategy.FALLBACK_RULE_CLOSEST_LOWER)).build()
        val rotation = display?.rotation ?: Surface.ROTATION_0
        val p = Preview.Builder().setResolutionSelector(resolution).setTargetRotation(rotation).build()
        p.setSurfaceProvider(ContextCompat.getMainExecutor(context)) { request ->
          Log.i("EdgeEmotionCamera", "Surface requested: ${request.resolution}, preview=${preview.width}x${preview.height}, front=$boundFront")
          preview.surfaceProvider.onSurfaceRequested(request)
        }
        val builder = ImageAnalysis.Builder().setResolutionSelector(resolution)
          .setTargetRotation(rotation).setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
          .setOutputImageFormat(ImageAnalysis.OUTPUT_IMAGE_FORMAT_RGBA_8888)
        Camera2Interop.Extender(builder).setSessionCaptureCallback(object : CameraCaptureSession.CaptureCallback() {
          override fun onCaptureCompleted(session: CameraCaptureSession, request: CaptureRequest, result: TotalCaptureResult) {
            if (generation == token) captured.incrementAndGet()
          }
        })
        val a = builder.build()
        analysis = a
        previewUseCase = p
        a.setAnalyzer(worker) { image -> analyze(image, token) }
        val group = UseCaseGroup.Builder().addUseCase(p).addUseCase(a)
        preview.viewPort?.let { group.setViewPort(it) }
        val camera = cameraProvider.bindToLifecycle(owner ?: error("No camera lifecycle"), selector, group.build())
        realtimeTimestamps = Camera2CameraInfo.from(camera.cameraInfo)
          .getCameraCharacteristic(CameraCharacteristics.SENSOR_INFO_TIMESTAMP_SOURCE) ==
          CameraCharacteristics.SENSOR_INFO_TIMESTAMP_SOURCE_REALTIME
        state = "waiting"
        cameraInfo = camera.cameraInfo
        cameraObserver = Observer { cameraState ->
          if (token != generation || !running) return@Observer
          val error = cameraState.error
          Log.d("EdgeEmotionCamera", "Camera state=${cameraState.type}, error=${error?.code}")
          if (error != null) {
            val message = cameraErrorDetail(error)
            Log.e("EdgeEmotionCamera", message, error.cause)
            current = null
            overlay.box = null
            overlay.invalidate()
            if (error.type == CameraState.ErrorType.RECOVERABLE) {
              // CameraX owns recovery for camera-in-use/disconnection errors.
              detail = message
              state = "camera_recovering"
              emit(emptyList())
            } else {
              fail("camera_error", message)
            }
          } else if (state == "camera_recovering" && cameraState.type == CameraState.Type.OPEN) {
            detail = null
            state = "waiting"
          }
        }
        camera.cameraInfo.cameraState.observe(owner!!, cameraObserver!!)
        orientation.enable()
      } catch (error: Exception) {
        Log.e("EdgeEmotionCamera", "Camera binding failed", error)
        fail("camera_error", "${error.javaClass.simpleName}: ${error.message}")
      }
    }, ContextCompat.getMainExecutor(context))
  }

  private fun cameraErrorDetail(error: CameraState.StateError): String {
    val name = when (error.code) {
      CameraState.ERROR_STREAM_CONFIG -> "ERROR_STREAM_CONFIG"
      CameraState.ERROR_CAMERA_IN_USE -> "ERROR_CAMERA_IN_USE"
      CameraState.ERROR_MAX_CAMERAS_IN_USE -> "ERROR_MAX_CAMERAS_IN_USE"
      CameraState.ERROR_CAMERA_DISABLED -> "ERROR_CAMERA_DISABLED"
      CameraState.ERROR_CAMERA_FATAL_ERROR -> "ERROR_CAMERA_FATAL_ERROR"
      else -> "CAMERA_ERROR"
    }
    val causes = generateSequence(error.cause) { it.cause }.take(4)
      .joinToString(" <- ") { "${it.javaClass.simpleName}: ${it.message}" }
    return "$name (${error.code}), ${if (boundFront) "front" else "back"}, " +
      "preview=${preview.width}x${preview.height}, " +
      "analysis=${analysis?.resolutionInfo?.resolution}" +
      if (causes.isEmpty()) "" else ": $causes"
  }

  private fun analyze(image: ImageProxy, token: Long) {
    if (token != generation || disposed) { image.close(); return }
    val start = SystemClock.elapsedRealtime()
    val id = ++sequence
    val sensorNs = image.imageInfo.timestamp
    val capturedMs = if (realtimeTimestamps) sensorNs / 1_000_000.0 else null
    val record = mutableMapOf<String, Any?>(
      "sessionId" to token.toString(), "frameId" to id.toDouble(),
      "capturedAtMs" to capturedMs, "sensorTimestampNs" to sensorNs.toString(),
      "analysisStartedAtMs" to start.toDouble(), "timestampMs" to (capturedMs ?: start.toDouble()),
      "timestampSource" to if (realtimeTimestamps) "sensor_realtime" else "analyzer_arrival",
      "status" to "inference_failed", "tag" to null, "probabilities" to null,
      "confidence" to null, "faceBox" to null, "captureToResultMs" to null
    )
    var box: RectF? = null
    var transform: OutputTransform? = null
    var bitmap: Bitmap? = null
    var stage = "coordinate_transform"
    try {
      transform = ImageProxyTransformFactory().apply {
        isUsingCropRect = true
        isUsingRotationDegrees = true
      }.getOutputTransform(image)
      stage = "image_conversion"
      val raw = image.toBitmap()
      val crop = image.cropRect
      val matrix = Matrix().apply { postRotate(image.imageInfo.rotationDegrees.toFloat()) }
      val oriented = try {
        Bitmap.createBitmap(raw, crop.left, crop.top, crop.width(), crop.height(), matrix, false)
      } catch (error: Exception) {
        raw.recycle()
        throw error
      }
      bitmap = oriented
      if (raw !== oriented) raw.recycle()
      record["imageWidth"] = oriented.width
      record["imageHeight"] = oriented.height
      val detectStart = SystemClock.elapsedRealtime()
      stage = "face_detection"
      engine!!.withDetectedFaces(oriented) { faces ->
        record["detectionMs"] = (SystemClock.elapsedRealtime() - detectStart).toDouble()
        record["faceCount"] = faces.size
        when {
          faces.isEmpty() -> record["status"] = "no_face"
          faces.size > 1 -> record["status"] = "multiple_faces"
          else -> {
            val b = faces.single()
            box = b
            if (!listOf(b.left, b.top, b.right, b.bottom).all { it.isFinite() } ||
              b.width() <= 0 || b.height() <= 0 ||
              !RectF.intersects(b, RectF(0f, 0f, oriented.width.toFloat(), oriented.height.toFloat()))) {
              record["status"] = "invalid_crop"
              box = null
            } else {
              record["faceBox"] = listOf(b.left, b.top, b.right, b.bottom)
              val inferenceStart = SystemClock.elapsedRealtime()
              stage = "emotion_classification"
              val p = engine!!.classify(oriented, b)
              val best = p.indices.maxBy { p[it] }
              record["status"] = "valid"
              record["tag"] = EmotionMath.labels[best]
              record["probabilities"] = p.toList()
              record["confidence"] = p[best]
              record["preprocessAndInferenceMs"] = (SystemClock.elapsedRealtime() - inferenceStart).toDouble()
            }
          }
        }
      }
      lastFailureSignature = null
    } catch (error: Exception) {
      val message = "$stage: ${error.javaClass.simpleName}: ${error.message}"
      record["status"] = "inference_failed"
      record["error"] = message
      record["errorStage"] = stage
      record["tag"] = null
      record["probabilities"] = null
      record["confidence"] = null
      record["faceBox"] = null
      val now = SystemClock.elapsedRealtime()
      if (message != lastFailureSignature || now - lastFailureLogAt >= 5000) {
        Log.e("EdgeEmotionInference", "frame=$id session=$token $message", error)
        lastFailureSignature = message
        lastFailureLogAt = now
      }
      box = null
    } finally {
      bitmap?.let { if (!it.isRecycled) it.recycle() }
      image.close()
    }
    val end = SystemClock.elapsedRealtime()
    record["completedAtMs"] = end.toDouble()
    record["processingMs"] = (end - start).toDouble()
    record["captureToResultMs"] = capturedMs?.let { end - it }
    val resultBox = box?.let { RectF(it) }
    val sourceTransform = transform
    main.post {
      if (disposed || token != generation) return@post
      analyzed++
      history.addLast(record)
      evict(if (freezeAt > 0) freezeAt else end)
      if (running) {
        current = record
        lastResultAt = end
        state = record["status"] as String
        overlay.box = if (resultBox != null && sourceTransform != null && preview.outputTransform != null) {
          try { RectF(resultBox).also { CoordinateTransform(sourceTransform, preview.outputTransform!!).mapRect(it) } }
          catch (_: Exception) { null }
        } else null
        overlay.label = record["tag"] as? String ?: ""
        overlay.invalidate()
      }
    }
  }

  private fun evict(now: Long) {
    while (history.isNotEmpty() && (history.size > 900 ||
        now - (history.first()["timestampMs"] as Number).toDouble() > 30_000)) history.removeFirst()
  }

  private fun emit(records: List<Map<String, Any?>>) {
    if (disposed) return
    val now = if (freezeAt > 0) freezeAt else SystemClock.elapsedRealtime()
    evict(now)
    val recent = history.filter { now - (it["timestampMs"] as Number).toDouble() <= 3000 }
    val latencies = recent.mapNotNull { it["captureToResultMs"] as? Double }.sorted()
    onFrames(mapOf<String, Any?>(
      // Retain and retransmit unacknowledged records: a coalesced/delayed UI event
      // cannot silently turn a batch into a single surviving analysis frame.
      "sessionId" to generation.toString(), "records" to history.filter {
        val ack = acknowledged.split(":")
        val last = if (ack.firstOrNull() == generation.toString()) ack.getOrNull(1)?.toLongOrNull() ?: 0 else 0
        (it["frameId"] as Number).toLong() > last
      }, "nowMs" to now.toDouble(),
      "state" to state, "detail" to detail, "current" to current,
      "historyCount" to history.size, "analyzedFrames" to analyzed.toDouble(),
      "analysisFps" to if (recent.size > 1) (recent.size - 1) * 1000.0 /
        ((recent.last()["analysisStartedAtMs"] as Number).toDouble() -
          (recent.first()["analysisStartedAtMs"] as Number).toDouble()).coerceAtLeast(1.0) else 0.0,
      "cameraFramesObserved" to captured.get().toDouble(),
      "backpressureDroppedEstimate" to (captured.get() - analyzed).coerceAtLeast(0).toDouble(),
      "captureLatencyP95Ms" to if (latencies.isEmpty()) null else latencies[(kotlin.math.ceil(latencies.size * .95).toInt() - 1).coerceAtLeast(0)],
      "timestampSource" to if (realtimeTimestamps) "sensor_realtime" else "analyzer_arrival"
    ))
  }

  private fun stop(reason: String) {
    running = false
    freezeAt = SystemClock.elapsedRealtime()
    state = reason
    orientation.disable()
    cameraObserver?.let { cameraInfo?.cameraState?.removeObserver(it) }
    cameraObserver = null
    cameraInfo = null
    analysis?.clearAnalyzer()
    val cases = listOfNotNull(analysis, previewUseCase)
    if (cases.isNotEmpty()) provider?.unbind(*cases.toTypedArray())
    analysis = null
    previewUseCase = null
    overlay.box = null
    overlay.invalidate()
    emit(emptyList())
  }

  private fun fail(reason: String, message: String?) {
    detail = message
    current = null
    stop(reason)
  }

  fun dispose() {
    if (disposed) return
    stop("closed")
    disposed = true
    generation++
    main.removeCallbacks(ticker)
    history.clear()
    worker.execute { engine?.close(); engine = null }
    worker.shutdown()
  }

  private class FaceOverlay(context: Context) : View(context) {
    var box: RectF? = null
    var label = ""
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(65, 217, 237); strokeWidth = 4f }
    override fun onDraw(canvas: Canvas) {
      val rect = box ?: return
      paint.style = Paint.Style.STROKE
      canvas.drawRoundRect(rect, 12f, 12f, paint)
      paint.style = Paint.Style.FILL
      paint.textSize = 36f
      canvas.drawText(label, rect.left.coerceAtLeast(8f), (rect.top - 12f).coerceAtLeast(40f), paint)
    }
  }
}
