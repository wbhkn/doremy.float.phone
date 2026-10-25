package app.floatphone.shell

import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

/**
 * 系统授权截屏的承载服务——**必须存在，不是可选优化**。
 *
 * Android 10（Q）起，targetSdk >= 29 的 App 在调
 * `MediaProjectionManager.getMediaProjection()` 之前，必须已经有一个
 * `foregroundServiceType="mediaProjection"` 的前台服务在跑；否则系统直接抛
 * `SecurityException: Media projections require a foreground service of type ...`。
 * 这条约束在 AOSP 的 `MediaProjectionManagerService` 里写死（见
 * `REQUIRE_FG_SERVICE_FOR_PROJECTION`），跟设备版本无关，只跟 targetSdk 有关。
 *
 * 之前这段逻辑放在 Activity 里就地取投影，Mate 10（Android 10）正好踩中这条，
 * 表现就是设置页诊断里的「系统没有给出截屏通道」。
 *
 * 服务只活一次截屏的时长：进前台 → 取投影 → 取一帧 → 收通知退出。
 * 不常驻、不录屏——和「看一眼」的语义保持一致。
 */
class ProjectionCaptureService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val resultCode = intent?.getIntExtra(EXTRA_RESULT_CODE, Activity.RESULT_CANCELED)
            ?: Activity.RESULT_CANCELED
        @Suppress("DEPRECATION")
        val data: Intent? = intent?.getParcelableExtra(EXTRA_RESULT_DATA)

        // 先登记：后面无论成功、失败还是异常，ProjectionCapture.finish() 都会把服务停掉。
        ProjectionCapture.attachService(this)

        // 关键顺序：先进前台（带 mediaProjection 类型），再碰 getMediaProjection()。
        // 反过来的话系统直接拒绝，这就是老版本报「没有截屏通道」的真正原因。
        if (!promoteToForeground()) {
            ProjectionCapture.onServiceDown("系统不让截屏服务进前台，这次没法截")
            return START_NOT_STICKY
        }
        if (resultCode != Activity.RESULT_OK || data == null) {
            ProjectionCapture.onServiceDown("你取消了截屏授权")
            return START_NOT_STICKY
        }

        ProjectionCapture.captureFromService(this, resultCode, data)
        return START_NOT_STICKY
    }

    /** 取完一帧（或失败）后由 [ProjectionCapture] 调用：收起通知并退出。 */
    fun stopCapture() {
        runCatching { stopForeground(STOP_FOREGROUND_REMOVE) }
        stopSelf()
    }

    private fun promoteToForeground(): Boolean = runCatching {
        ensureChannel()
        val notification = buildNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
        } else {
            startForeground(NOTIF_ID, notification)
        }
        true
    }.getOrDefault(false)

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        runCatching {
            getSystemService(NotificationManager::class.java).createNotificationChannel(
                NotificationChannel(CH, "看一眼屏幕", NotificationManager.IMPORTANCE_MIN).apply {
                    description = "取一帧画面时短暂出现，截完就消失"
                    setShowBadge(false)
                },
            )
        }
    }

    /** 静默通知：服务只活一两秒，用户不该被两条通知刷屏。 */
    private fun buildNotification(): Notification {
        val open = PendingIntent.getActivity(
            this, 92,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return NotificationCompat.Builder(this, CH)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle("小手机")
            .setContentText("正在看一眼屏幕…")
            .setOngoing(true)
            .setSilent(true)
            .setContentIntent(open)
            .build()
    }

    companion object {
        private const val CH = "float-projection"
        private const val NOTIF_ID = 0x5F20
        private const val EXTRA_RESULT_CODE = "result_code"
        private const val EXTRA_RESULT_DATA = "result_data"

        /**
         * 拉起前台服务，把授权结果（resultCode + data）带过去。
         *
         * @return false 表示系统当场拒绝启动（极少见），调用方应如实报错。
         */
        fun start(context: Context, resultCode: Int, data: Intent): Boolean = runCatching {
            val intent = Intent(context, ProjectionCaptureService::class.java)
                .putExtra(EXTRA_RESULT_CODE, resultCode)
                .putExtra(EXTRA_RESULT_DATA, data)
            ContextCompat.startForegroundService(context, intent)
            true
        }.getOrDefault(false)
    }
}
