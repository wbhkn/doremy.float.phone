package app.floatphone.shell

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.Image
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.util.DisplayMetrics
import org.json.JSONObject
import java.lang.ref.WeakReference

/**
 * 系统授权截屏（MediaProjection）——给 Android 10 及以下的机器兜底。
 *
 * 为什么需要它：主路径走的是无障碍服务的 `takeScreenshot()`，那个 API 是
 * Android 11（API 30）才有的。老机器（比如 Mate 10，停在 Android 10）上
 * 无障碍那条路根本不存在，功能整个用不了。
 *
 * MediaProjection 从 Android 5.0 就有，代价是**每次都要弹一次系统授权框**——
 * 用户点「立即开始」才拿得到画面。两条路的差别：
 *   · 无障碍：不弹框、快，但系统版本要够；
 *   · 系统授权：什么版本都能用，但每截一张弹一次框。
 * 因此在 [ScreenshotBridge] 里按「无障碍优先、不行再授权」的顺序自动选路，
 * 网页侧完全不用关心走的是哪条。
 *
 * 取到一帧就立刻放手：`VirtualDisplay` / `ImageReader` / `MediaProjection`
 * 全部释放，不常驻、不录屏、不做二次截取——和「看一眼」的语义保持一致。
 */
object ProjectionCapture {

    /** 等第一帧的上限。正常一两百毫秒就有帧；超过这个时间基本是 ROM 卡住了。 */
    private const val FIRST_FRAME_TIMEOUT_MS = 5000L

    private val main = Handler(Looper.getMainLooper())

    /** 当前页面所在的 Activity。授权框必须从 Activity 起，Service 起不了。 */
    private var host: WeakReference<MainActivity>? = null

    /** 这一次等待中的回调（同一时刻只允许一张）。 */
    private var pending: ((Bitmap?, String?) -> Unit)? = null

    /** 有授权框在等，或正在取帧。防连点。 */
    @Volatile
    private var busy: Boolean = false

    fun isBusy(): Boolean = busy

    /** 由 MainActivity.onCreate 登记。 */
    fun attachHost(activity: MainActivity) {
        host = WeakReference(activity)
    }

    /** 由 MainActivity.onDestroy 注销；同一实例才会被清掉，避免误伤新页面。 */
    fun detachHost(activity: MainActivity) {
        if (host?.get() === activity) host = null
        // 页面没了，等着的那次截屏也就不可能成功了，如实收场，别让网页一直转圈。
        if (busy) finish(null, "页面已经关闭，这次没看成")
    }

    /** 这个版本的 Android 能不能走系统授权截屏。 */
    fun isSupported(): Boolean = Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP

    /**
     * 发起一次「弹授权框 → 取一帧」的截屏。
     *
     * 立即返回（只表示受理了），画面稍后经 [onResult] 回调；
     * 失败时 bitmap 为 null、reason 是一句能直接转述给用户的话。
     */
    fun request(onResult: (Bitmap?, String?) -> Unit): JSONObject {
        if (!isSupported()) return failure("系统版本太低，用不了系统截屏")
        if (busy) return failure("上一次截屏还没结束，请稍等一下")
        val activity = host?.get()
        if (activity == null || activity.isFinishing) {
            return failure("请先把 App 打开，再让我看一眼屏幕")
        }

        busy = true
        pending = onResult

        // 授权框必须在主线程拉起；JS 桥的调用线程不是主线程，这里转一手。
        main.post {
            val started = runCatching { activity.requestScreenCaptureConsent() }.getOrDefault(false)
            if (!started) {
                finish(null, "没能拉起系统截屏授权，请重试")
            }
        }
        return JSONObject().put("ok", true).put("accepted", true).put("mode", "projection")
    }

    /** MainActivity 的授权回调转发到这里（主线程）。 */
    fun onConsentResult(activity: MainActivity, resultCode: Int, data: Intent?) {
        if (!busy) return
        if (resultCode != Activity.RESULT_OK || data == null) {
            // 用户点了取消——这是正常操作，不是错误，文案别写得像出了故障。
            finish(null, "你取消了截屏授权")
            return
        }
        val manager = activity.getSystemService(Context.MEDIA_PROJECTION_SERVICE) as? MediaProjectionManager
        if (manager == null) {
            finish(null, "这台手机取不到系统截屏服务")
            return
        }
        val projection = runCatching { manager.getMediaProjection(resultCode, data) }.getOrNull()
        if (projection == null) {
            finish(null, "系统没有给出截屏通道")
            return
        }
        captureFirstFrame(activity, projection)
    }

    // ── 取帧 ────────────────────────────────────────────────

    /**
     * 建一块镜像屏，等第一帧就收工。
     *
     * 所有清理都集中在 [release]：不管成功、超时还是抛异常，都必须把
     * 虚拟屏和投影关掉——常驻的话状态栏会一直挂着投屏图标，用户会以为
     * 手机在录屏。
     */
    private fun captureFirstFrame(activity: Activity, projection: MediaProjection) {
        val thread = HandlerThread("float-projection").also { it.start() }
        val handler = Handler(thread.looper)

        var reader: ImageReader? = null
        var display: VirtualDisplay? = null
        var done = false

        fun release() {
            runCatching { display?.release() }
            runCatching { reader?.close() }
            // stop() 在某些 ROM 上会抛（已停过、通道已失效），吞掉即可：此时
            // 画面已经拿到手，不该因为收尾失败把成功改判成失败。
            runCatching { projection.stop() }
            runCatching { thread.quitSafely() }
            display = null
            reader = null
        }

        val timeout = Runnable {
            if (done) return@Runnable
            done = true
            release()
            main.post { finish(null, "没等到屏幕画面，请重试一次") }
        }

        try {
            val metrics = DisplayMetrics()
            @Suppress("DEPRECATION")
            activity.windowManager.defaultDisplay.getRealMetrics(metrics)
            val width = metrics.widthPixels
            val height = metrics.heightPixels
            if (width <= 0 || height <= 0) {
                release()
                finish(null, "读不到屏幕尺寸")
                return
            }

            // 注册回调是 Android 14 的硬性要求（不注册会直接抛），老版本上是空操作。
            runCatching { projection.registerCallback(object : MediaProjection.Callback() {}, handler) }

            val created = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2)
            reader = created
            created.setOnImageAvailableListener({ source ->
                if (done) {
                    runCatching { source.acquireLatestImage()?.close() }
                    return@setOnImageAvailableListener
                }
                val image = runCatching { source.acquireLatestImage() }.getOrNull()
                    ?: return@setOnImageAvailableListener
                done = true
                handler.removeCallbacks(timeout)
                val bitmap = runCatching { toBitmap(image, width, height) }.getOrNull()
                runCatching { image.close() }
                release()
                main.post {
                    if (bitmap == null) {
                        finish(null, "屏幕画面转换失败")
                    } else {
                        finish(bitmap, null)
                    }
                }
            }, handler)

            display = projection.createVirtualDisplay(
                "float-peek",
                width,
                height,
                metrics.densityDpi,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                created.surface,
                null,
                handler,
            )
            handler.postDelayed(timeout, FIRST_FRAME_TIMEOUT_MS)
        } catch (e: Throwable) {
            release()
            finish(null, e.message ?: "系统截屏启动失败")
        }
    }

    /**
     * Image → 软件位图。
     *
     * 行跨度通常比「宽 × 4」大（对齐填充），直接按宽读会把画面读歪，
     * 所以先按跨度建图、再裁掉右侧的填充像素。
     */
    private fun toBitmap(image: Image, width: Int, height: Int): Bitmap? {
        val plane = image.planes.firstOrNull() ?: return null
        val buffer = plane.buffer
        buffer.rewind()
        val pixelStride = plane.pixelStride
        val rowStride = plane.rowStride
        val rowPadding = rowStride - pixelStride * width
        val paddedWidth = width + rowPadding / pixelStride
        val raw = Bitmap.createBitmap(paddedWidth, height, Bitmap.Config.ARGB_8888)
        raw.copyPixelsFromBuffer(buffer)
        if (paddedWidth == width) return raw
        val cropped = Bitmap.createBitmap(raw, 0, 0, width, height)
        if (cropped !== raw) runCatching { raw.recycle() }
        return cropped
    }

    // ── 收尾 ────────────────────────────────────────────────

    private fun finish(bitmap: Bitmap?, reason: String?) {
        busy = false
        val callback = pending
        pending = null
        if (callback == null) {
            if (reason != null) ScreenshotBridge.publishGrabFailure(reason)
            runCatching { bitmap?.recycle() }
            return
        }
        runCatching { callback(bitmap, reason) }
    }

    private fun failure(reason: String): JSONObject =
        JSONObject().put("ok", false).put("reason", reason)
}
