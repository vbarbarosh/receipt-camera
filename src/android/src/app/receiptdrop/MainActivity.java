package app.receiptdrop;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.ColorMatrix;
import android.graphics.ColorMatrixColorFilter;
import android.graphics.ImageFormat;
import android.graphics.Paint;
import android.graphics.RectF;
import android.graphics.SurfaceTexture;
import android.graphics.drawable.GradientDrawable;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CaptureFailure;
import android.hardware.camera2.CaptureRequest;
import android.hardware.camera2.CaptureResult;
import android.hardware.camera2.TotalCaptureResult;
import android.hardware.camera2.params.StreamConfigurationMap;
import android.media.Image;
import android.media.ImageReader;
import android.media.MediaActionSound;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.SystemClock;
import android.os.Vibrator;
import android.text.InputType;
import android.util.Range;
import android.util.Rational;
import android.util.Size;
import android.view.Gravity;
import android.view.Surface;
import android.view.TextureView;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.TextView;
import android.widget.Toast;
import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

public class MainActivity extends Activity
{
    private static final String default_server = "http://192.168.100.44:8080";
    private static final int detect_h = 120;
    private static final int detect_w = 90;

    // A hand needs longer than a third of a second to stop moving after it
    // arrives: at 300ms the gate opened mid-settle and the shot carried the
    // residual drift. Box thresholds are fractions of the frame.
    private static final long settle_ms = 600;
    private static final float settle_shift = 0.010f;
    private static final float settle_grow = 0.020f;
    // Laplacian energy of a receipt that reads cleanly; sharp shots land near
    // 1500, everything that failed to decode came in under 700.
    private static final double sharp_floor = 900;
    private static final long focus_lock_timeout_ms = 1800;
    // The HAL reports exposure in coarse buckets (10/30/60ms), so the torch
    // tests have to straddle a bucket boundary, and dwell, or it flaps.
    private static final long torch_on_ms = 60;
    private static final long torch_off_ms = 10;
    private static final long torch_dwell_ms = 1500;

    private String app_version = "apk-0";

    private int preview_af_mode = CaptureRequest.CONTROL_AF_MODE_OFF;
    private int capture_af_mode = CaptureRequest.CONTROL_AF_MODE_OFF;
    private boolean optical_stabilization = false;
    private final FocusLock focus_lock = new FocusLock();
    private boolean focus_for_auto;
    private volatile long armed_since_ms = 0;
    private int ae_compensation_min = 0;
    private double ae_compensation_step = 0;
    private volatile boolean awaiting_focus_lock = false;
    private volatile boolean auto_armed = true;
    private TextView auto_button;
    private volatile boolean auto_enabled = true;
    private Handler background_handler;
    private HandlerThread background_thread;
    private volatile boolean burst_active = false;
    private volatile int burst_completed = 0;
    private boolean burst_images_ready = false;
    private volatile int burst_count = 3;
    private final ArrayList<byte[]> burst_frames = new ArrayList<>();
    private static final int burst_max = 5;
    private CameraDevice camera;
    private String camera_id;
    private volatile boolean capture_ready = false;
    private volatile long capture_trigger_ms = 0;
    private boolean connected = false;
    private float detect_angle_deg = 0f;
    private float detect_area = 0f;
    private final RectF detect_box = new RectF();
    private boolean detect_cut_bottom = false;
    private boolean detect_cut_left = false;
    private boolean detect_cut_right = false;
    private boolean detect_cut_top = false;
    private int[] detect_labels;
    private int[] detect_stack;
    private volatile boolean detection_ok = false;
    private TextView light_button;
    private String light_mode = "auto";
    private View flash_view;
    private Bitmap frame_bitmap;
    private int[] frame_pixels;
    private volatile float gravity_x = 0f;
    private volatile float gravity_y = 0f;
    private GridOverlay grid;
    private Size jpeg_size;
    private volatile long focus_lock_started_ms = 0;
    private volatile long last_af_ok_ms = 0;
    private volatile long last_box_motion_ms = 0;
    private volatile long last_capture_ms = 0;
    private volatile long last_detected_ms = 0;
    private long last_gate_log_ms = 0;
    private volatile long last_motion_ms = 0;
    private int[] lum_current;
    private int[] lum_previous;
    private boolean lum_valid = false;
    private boolean manual_sensor = false;
    private int max_iso = 800;
    private volatile long preview_exposure_ns = 0;
    private volatile int preview_iso = 0;
    private final SteadyBox steady_box = new SteadyBox(settle_shift, settle_grow);
    private Size preview_size;
    private Surface preview_surface;
    private final RectF smooth_box = new RectF();
    private volatile int soft_retries = 0;
    private Range<Integer> still_fps_range = null;
    private volatile long torch_bright_since_ms = 0;
    private volatile long torch_dim_since_ms = 0;
    private boolean torch_available = false;
    private volatile boolean torch_on = false;
    private ImageReader reader;
    private Button retry;
    private FrameLayout root;
    private int saved_count = 0;
    private int sensor_orientation = 90;
    private SensorManager sensor_manager;
    private CameraCaptureSession session;
    private float shot_center_x = 0f;
    private float shot_center_y = 0f;
    private Button shutter;
    private MediaActionSound sound;
    private TextView status;
    private TextureView texture_view;
    private Handler ui_handler;

    @Override
    protected void onCreate(Bundle saved_state)
    {
        super.onCreate(saved_state);

        root = new FrameLayout(this);
        root.setBackgroundColor(0xFF000000);
        root.setKeepScreenOn(true);

        texture_view = new TextureView(this);
        root.addView(texture_view, new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

        grid = new GridOverlay(this);
        root.addView(grid, new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

        flash_view = new View(this);
        flash_view.setBackgroundColor(0xFFFFFFFF);
        flash_view.setAlpha(0f);
        root.addView(flash_view, new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

        status = new TextView(this);
        status.setTextColor(0xFFFFFFFF);
        status.setTextSize(14f);
        GradientDrawable status_bg = new GradientDrawable();
        status_bg.setColor(0xCC000000);
        status_bg.setCornerRadius(dp(16));
        status.setBackground(status_bg);
        status.setPadding(dp(14), dp(8), dp(14), dp(8));
        FrameLayout.LayoutParams status_params = new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT,
            Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL);
        status_params.bottomMargin = dp(140);
        root.addView(status, status_params);

        shutter = new Button(this);
        GradientDrawable circle = new GradientDrawable();
        circle.setShape(GradientDrawable.OVAL);
        circle.setColor(0xFF2F6DF6);
        circle.setStroke(dp(4), 0xEEFFFFFF);
        shutter.setBackground(circle);
        FrameLayout.LayoutParams shutter_params = new FrameLayout.LayoutParams(
            dp(84), dp(84), Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL);
        shutter_params.bottomMargin = dp(36);
        root.addView(shutter, shutter_params);
        shutter.setOnClickListener(view -> {
            auto_armed = false;
            capture(false);
        });

        TextView server_button = new TextView(this);
        server_button.setText("server");
        server_button.setTextColor(0xCCFFFFFF);
        server_button.setShadowLayer(4f, 0f, 1f, 0xAA000000);
        server_button.setTextSize(14f);
        server_button.setPadding(dp(16), dp(16), dp(16), dp(16));
        FrameLayout.LayoutParams server_params = new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT,
            Gravity.TOP | Gravity.END);
        root.addView(server_button, server_params);
        server_button.setOnClickListener(view -> show_server_dialog());

        auto_enabled = prefs().getBoolean("auto", true);
        auto_button = new TextView(this);
        auto_button.setTextColor(0xCCFFFFFF);
        auto_button.setShadowLayer(4f, 0f, 1f, 0xAA000000);
        auto_button.setTextSize(14f);
        auto_button.setPadding(dp(16), dp(16), dp(16), dp(16));
        root.addView(auto_button, new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT,
            Gravity.TOP | Gravity.START));
        auto_button.setText(auto_enabled ? "auto: on" : "auto: off");
        auto_button.setOnClickListener(view -> {
            auto_enabled = !auto_enabled;
            prefs().edit().putBoolean("auto", auto_enabled).apply();
            auto_armed = true;
            armed_since_ms = SystemClock.elapsedRealtime();
            auto_button.setText(auto_enabled ? "auto: on" : "auto: off");
            if (session != null)
                status.setText(auto_enabled
                    ? "hold steady over the receipt"
                    : "hover over the receipt, tap the button");
        });

        light_mode = prefs().getString("light", "auto");
        light_button = new TextView(this);
        light_button.setTextColor(0xCCFFFFFF);
        light_button.setShadowLayer(4f, 0f, 1f, 0xAA000000);
        light_button.setTextSize(14f);
        light_button.setPadding(dp(16), dp(16), dp(16), dp(16));
        FrameLayout.LayoutParams light_params = new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT,
            Gravity.TOP | Gravity.START);
        light_params.topMargin = dp(44);
        root.addView(light_button, light_params);
        light_button.setText("light: " + light_mode);
        light_button.setOnClickListener(view -> {
            light_mode = light_mode.equals("auto") ? "on" : light_mode.equals("on") ? "off" : "auto";
            prefs().edit().putString("light", light_mode).apply();
            light_button.setText("light: " + light_mode);
            if (light_mode.equals("on"))
                set_torch(true);
            if (light_mode.equals("off"))
                set_torch(false);
        });

        retry = new Button(this);
        retry.setText("retry");
        retry.setVisibility(View.GONE);
        root.addView(retry, new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT,
            Gravity.CENTER));
        retry.setOnClickListener(view -> check_server());

        setContentView(root);

        ui_handler = new Handler(getMainLooper());
        frame_bitmap = Bitmap.createBitmap(detect_w, detect_h, Bitmap.Config.ARGB_8888);
        frame_pixels = new int[detect_w * detect_h];
        lum_current = new int[detect_w * detect_h];
        lum_previous = new int[detect_w * detect_h];
        detect_labels = new int[detect_w * detect_h];
        detect_stack = new int[detect_w * detect_h];

        app_version = "apk-" + my_version_code();
        status.setText("connecting to server…");

        sound = new MediaActionSound();
        sound.load(MediaActionSound.SHUTTER_CLICK);

        texture_view.setSurfaceTextureListener(new TextureView.SurfaceTextureListener() {
            @Override
            public void onSurfaceTextureAvailable(SurfaceTexture texture, int width, int height)
            {
                maybe_open_camera();
            }

            @Override
            public void onSurfaceTextureSizeChanged(SurfaceTexture texture, int width, int height) {}

            @Override
            public boolean onSurfaceTextureDestroyed(SurfaceTexture texture)
            {
                return true;
            }

            @Override
            public void onSurfaceTextureUpdated(SurfaceTexture texture) {}
        });

        log("app-started", android.os.Build.MODEL + " android " + android.os.Build.VERSION.RELEASE);
    }

    @Override
    protected void onResume()
    {
        super.onResume();
        background_thread = new HandlerThread("camera");
        background_thread.start();
        background_handler = new Handler(background_thread.getLooper());
        last_motion_ms = SystemClock.elapsedRealtime();
        sensor_manager = (SensorManager) getSystemService(SENSOR_SERVICE);
        Sensor gyro = sensor_manager.getDefaultSensor(Sensor.TYPE_GYROSCOPE);
        if (gyro != null)
            sensor_manager.registerListener(sensor_listener, gyro, SensorManager.SENSOR_DELAY_GAME);
        Sensor accel = sensor_manager.getDefaultSensor(Sensor.TYPE_LINEAR_ACCELERATION);
        if (accel != null)
            sensor_manager.registerListener(sensor_listener, accel, SensorManager.SENSOR_DELAY_GAME);
        Sensor gravity = sensor_manager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER);
        if (gravity != null)
            sensor_manager.registerListener(sensor_listener, gravity, SensorManager.SENSOR_DELAY_GAME);
        last_box_motion_ms = SystemClock.elapsedRealtime();
        armed_since_ms = last_box_motion_ms;
        steady_box.reset();
        lum_valid = false;
        ui_handler.postDelayed(frame_watcher, 400);
        check_server();
    }

    @Override
    protected void onPause()
    {
        ui_handler.removeCallbacks(frame_watcher);
        sensor_manager.unregisterListener(sensor_listener);
        background_handler.post(this::close_camera);
        background_thread.quitSafely();
        try {
            background_thread.join();
        } catch (InterruptedException ignored) {}
        background_handler = null;
        background_thread = null;
        super.onPause();
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] permissions, int[] results)
    {
        if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED)
            maybe_open_camera();
        else
            status.setText("camera permission required");
    }

    // startup gate: one request checks the server is reachable and whether a newer apk exists

    private void check_server()
    {
        status.setText("connecting to server…");
        retry.setVisibility(View.GONE);
        new Thread(() -> {
            try {
                HttpURLConnection connection =
                    (HttpURLConnection) new URL(server() + "/apk-version.txt").openConnection();
                connection.setConnectTimeout(3000);
                connection.setReadTimeout(3000);
                int code = connection.getResponseCode();
                String body = read_body(connection).trim();
                connection.disconnect();
                if (code != 200)
                    throw new Exception("http " + code);
                int latest = Integer.parseInt(body);
                connected = true;
                log("server-connected", "installed " + my_version_code() + " latest " + latest);
                runOnUiThread(() -> {
                    if (latest > my_version_code())
                        show_update_dialog(latest);
                    proceed_to_camera();
                });
            } catch (Exception error) {
                runOnUiThread(() -> {
                    status.setText("no server at " + server());
                    retry.setVisibility(View.VISIBLE);
                });
            }
        }).start();
    }

    private void proceed_to_camera()
    {
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED)
            requestPermissions(new String[] {Manifest.permission.CAMERA}, 1);
        else
            maybe_open_camera();
    }

    private int my_version_code()
    {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionCode;
        } catch (Exception error) {
            return 0;
        }
    }

    private void show_update_dialog(int latest)
    {
        new AlertDialog.Builder(this)
            .setTitle("Update available")
            .setMessage("Version " + latest + " is on the server (installed: " + my_version_code() + ").")
            .setPositiveButton("Update now", (dialog, which) -> download_and_install())
            .setNegativeButton("Later", null)
            .show();
    }

    // self-update: download the apk to cache and hand it to the system installer
    private void download_and_install()
    {
        status.setText("downloading update…");
        new Thread(() -> {
            try {
                HttpURLConnection connection =
                    (HttpURLConnection) new URL(server() + "/receipt-drop.apk").openConnection();
                connection.setConnectTimeout(3000);
                InputStream in = connection.getInputStream();
                FileOutputStream out = new FileOutputStream(new File(getCacheDir(), "update.apk"));
                byte[] chunk = new byte[65536];
                int read;
                while ((read = in.read(chunk)) > 0)
                    out.write(chunk, 0, read);
                out.close();
                in.close();
                connection.disconnect();
                Intent install = new Intent(Intent.ACTION_VIEW);
                install.setDataAndType(Uri.parse("content://app.receiptdrop.apk/update.apk"),
                    "application/vnd.android.package-archive");
                install.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                startActivity(install);
            } catch (Exception error) {
                log("update-failed", error.toString());
                runOnUiThread(() -> toast("update failed: " + error.getMessage()));
            }
        }).start();
    }

    // camera

    private void maybe_open_camera()
    {
        if (!connected || camera != null || !texture_view.isAvailable() || background_handler == null)
            return;
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED)
            return;
        CameraManager manager = (CameraManager) getSystemService(CAMERA_SERVICE);
        try {
            for (String id : manager.getCameraIdList()) {
                CameraCharacteristics chars = manager.getCameraCharacteristics(id);
                Integer facing = chars.get(CameraCharacteristics.LENS_FACING);
                if (facing == null || facing != CameraCharacteristics.LENS_FACING_BACK)
                    continue;
                camera_id = id;
                int[] af_modes = chars.get(CameraCharacteristics.CONTROL_AF_AVAILABLE_MODES);
                preview_af_mode = supports(af_modes, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE)
                    ? CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE
                    : supports(af_modes, CaptureRequest.CONTROL_AF_MODE_AUTO)
                        ? CaptureRequest.CONTROL_AF_MODE_AUTO : CaptureRequest.CONTROL_AF_MODE_OFF;
                capture_af_mode = supports(af_modes, CaptureRequest.CONTROL_AF_MODE_AUTO)
                    ? CaptureRequest.CONTROL_AF_MODE_AUTO : preview_af_mode;
                optical_stabilization = supports(
                    chars.get(CameraCharacteristics.LENS_INFO_AVAILABLE_OPTICAL_STABILIZATION),
                    CaptureRequest.LENS_OPTICAL_STABILIZATION_MODE_ON);
                Integer orientation = chars.get(CameraCharacteristics.SENSOR_ORIENTATION);
                if (orientation != null)
                    sensor_orientation = orientation;
                StreamConfigurationMap map = chars.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
                jpeg_size = largest(map.getOutputSizes(ImageFormat.JPEG));
                preview_size = pick_preview(map.getOutputSizes(SurfaceTexture.class));
                int[] capabilities = chars.get(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES);
                if (capabilities != null)
                    for (int capability : capabilities)
                        if (capability == CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES_MANUAL_SENSOR)
                            manual_sensor = true;
                Range<Integer> iso_range = chars.get(CameraCharacteristics.SENSOR_INFO_SENSITIVITY_RANGE);
                if (iso_range != null)
                    max_iso = iso_range.getUpper();
                Range<Integer> ev_range = chars.get(CameraCharacteristics.CONTROL_AE_COMPENSATION_RANGE);
                Rational ev_step = chars.get(CameraCharacteristics.CONTROL_AE_COMPENSATION_STEP);
                if (ev_range != null && ev_step != null && ev_step.doubleValue() > 0) {
                    ae_compensation_min = ev_range.getLower();
                    ae_compensation_step = ev_step.doubleValue();
                }
                Boolean flash = chars.get(CameraCharacteristics.FLASH_INFO_AVAILABLE);
                torch_available = flash != null && flash;
                Range<Integer>[] fps_ranges = chars.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES);
                if (fps_ranges != null)
                    for (Range<Integer> range : fps_ranges)
                        if (still_fps_range == null
                            || range.getLower() > still_fps_range.getLower()
                            || (range.getLower().equals(still_fps_range.getLower())
                                && range.getUpper() < still_fps_range.getUpper()))
                            still_fps_range = range;
                break;
            }
            if (camera_id == null) {
                status.setText("no back camera found");
                return;
            }
            log("camera-selected", "jpeg " + jpeg_size + " preview " + preview_size
                + " sensor " + sensor_orientation + " fps " + still_fps_range
                + " af " + preview_af_mode + "/" + capture_af_mode + " ois " + optical_stabilization);
            manager.openCamera(camera_id, camera_callback, background_handler);
        } catch (Exception error) {
            log("camera-open-failed", error.toString());
            status.setText("camera failed: " + error.getMessage());
        }
    }

    private static boolean supports(int[] modes, int wanted)
    {
        if (modes != null)
            for (int mode : modes)
                if (mode == wanted)
                    return true;
        return false;
    }

    private void apply_camera_controls(CaptureRequest.Builder builder, int af_mode)
    {
        builder.set(CaptureRequest.CONTROL_AF_MODE, af_mode);
        builder.set(CaptureRequest.FLASH_MODE, torch_on
            ? CaptureRequest.FLASH_MODE_TORCH : CaptureRequest.FLASH_MODE_OFF);
        if (optical_stabilization)
            builder.set(CaptureRequest.LENS_OPTICAL_STABILIZATION_MODE,
                CaptureRequest.LENS_OPTICAL_STABILIZATION_MODE_ON);
    }

    private Size largest(Size[] sizes)
    {
        Size out = sizes[0];
        for (Size size : sizes)
            if ((long) size.getWidth() * size.getHeight() > (long) out.getWidth() * out.getHeight())
                out = size;
        return out;
    }

    private Size pick_preview(Size[] sizes)
    {
        float jpeg_aspect = (float) jpeg_size.getWidth() / jpeg_size.getHeight();
        Size out = null;
        for (Size size : sizes) {
            if (size.getWidth() > 1920)
                continue;
            float aspect = (float) size.getWidth() / size.getHeight();
            if (Math.abs(aspect - jpeg_aspect) > 0.02f)
                continue;
            if (out == null || size.getWidth() > out.getWidth())
                out = size;
        }
        return out == null ? sizes[0] : out;
    }

    private final CameraDevice.StateCallback camera_callback = new CameraDevice.StateCallback() {
        @Override
        public void onOpened(CameraDevice device)
        {
            camera = device;
            start_session();
        }

        @Override
        public void onDisconnected(CameraDevice device)
        {
            device.close();
            camera = null;
        }

        @Override
        public void onError(CameraDevice device, int error)
        {
            log("camera-error", "code " + error);
            device.close();
            camera = null;
        }
    };

    private void start_session()
    {
        try {
            reader = ImageReader.newInstance(jpeg_size.getWidth(), jpeg_size.getHeight(), ImageFormat.JPEG, burst_max + 1);
            reader.setOnImageAvailableListener(r -> {
                if (r != reader)
                    return;
                Image image = r.acquireNextImage();
                if (image == null)
                    return;
                ByteBuffer buffer = image.getPlanes()[0].getBuffer();
                byte[] jpeg = new byte[buffer.remaining()];
                buffer.get(jpeg);
                image.close();
                if (!burst_active)
                    return;
                burst_frames.add(jpeg);
                if (burst_frames.size() < burst_count)
                    return;
                final ArrayList<byte[]> frames = new ArrayList<>(burst_frames);
                burst_frames.clear();
                burst_images_ready = true;
                finish_burst_if_ready();
                // scoring and brightening are heavy — keep the camera thread free
                new Thread(() -> {
                    int best = 0;
                    double best_score = -1;
                    StringBuilder scores = new StringBuilder();
                    for (int i = 0; i < frames.size(); i++) {
                        double score = sharpness(frames.get(i));
                        scores.append(Math.round(score)).append(' ');
                        if (score > best_score) {
                            best_score = score;
                            best = i;
                        }
                    }
                    log("burst-scores", scores + "kept #" + (best + 1));
                    keep_and_maybe_reshoot(frames.get(best), best_score);
                }).start();
            }, background_handler);

            SurfaceTexture texture = texture_view.getSurfaceTexture();
            texture.setDefaultBufferSize(preview_size.getWidth(), preview_size.getHeight());
            preview_surface = new Surface(texture);
            fit_preview();

            camera.createCaptureSession(Arrays.asList(preview_surface, reader.getSurface()),
                new CameraCaptureSession.StateCallback() {
                    @Override
                    public void onConfigured(CameraCaptureSession configured)
                    {
                        session = configured;
                        start_repeating();
                        runOnUiThread(() -> status.setText(auto_enabled
                            ? "hold steady over the receipt"
                            : "hover over the receipt, tap the button"));
                    }

                    @Override
                    public void onConfigureFailed(CameraCaptureSession failed)
                    {
                        log("session-failed", "configure failed");
                        runOnUiThread(() -> status.setText("camera session failed"));
                    }
                }, background_handler);
        } catch (Exception error) {
            log("session-failed", error.toString());
        }
    }

    private void set_torch(boolean on)
    {
        if (background_handler == null)
            return;
        background_handler.post(() -> {
            // A preview mode change would cancel the focus lock during a shot.
            if (torch_on == on || !torch_available || session == null
                || awaiting_focus_lock || burst_active)
                return;
            torch_on = on;
            last_motion_ms = SystemClock.elapsedRealtime();
            log("torch", on ? "on" : "off");
            start_repeating();
        });
    }

    private void start_repeating()
    {
        try {
            CaptureRequest.Builder builder = camera.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW);
            builder.addTarget(preview_surface);
            apply_camera_controls(builder, preview_af_mode);
            session.setRepeatingRequest(builder.build(), preview_callback, background_handler);
        } catch (Exception error) {
            log("preview-failed", error.toString());
        }
    }

    // portrait letterbox: match the view height to the rotated preview aspect
    private void fit_preview()
    {
        runOnUiThread(() -> {
            int width = root.getWidth();
            if (width == 0)
                return;
            float aspect = (float) preview_size.getWidth() / preview_size.getHeight();
            texture_view.setLayoutParams(new FrameLayout.LayoutParams(
                width, Math.round(width * aspect), Gravity.CENTER));
            grid.setLayoutParams(new FrameLayout.LayoutParams(
                width, Math.round(width * aspect), Gravity.CENTER));
        });
    }

    private void close_camera()
    {
        awaiting_focus_lock = false;
        focus_lock.cancel();
        if (background_handler != null)
            background_handler.removeCallbacks(focus_lock_expired);
        last_af_ok_ms = 0;
        capture_ready = false;
        burst_active = false;
        burst_frames.clear();
        if (session != null) {
            session.close();
            session = null;
        }
        if (camera != null) {
            camera.close();
            camera = null;
        }
        if (reader != null) {
            reader.close();
            reader = null;
        }
    }

    // Keep AUTO on both preview and still requests: changing AF mode between
    // the trigger and the JPEG would reset the lock. Tags reject old results.
    private void capture(boolean automatic)
    {
        if (background_handler != null)
            background_handler.post(() -> begin_focus_lock(automatic));
    }

    private void begin_focus_lock(boolean automatic)
    {
        if (session == null || camera == null || burst_active || awaiting_focus_lock)
            return;
        focus_for_auto = automatic;
        if (capture_af_mode == CaptureRequest.CONTROL_AF_MODE_OFF) {
            capture_burst();
            return;
        }
        try {
            CaptureRequest.Builder builder = camera.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW);
            builder.addTarget(preview_surface);
            apply_camera_controls(builder, capture_af_mode);
            builder.setTag(focus_lock.begin());
            awaiting_focus_lock = true;
            focus_lock_started_ms = SystemClock.elapsedRealtime();
            builder.set(CaptureRequest.CONTROL_AF_TRIGGER, CaptureRequest.CONTROL_AF_TRIGGER_START);
            session.capture(builder.build(), preview_callback, background_handler);
            builder.set(CaptureRequest.CONTROL_AF_TRIGGER, CaptureRequest.CONTROL_AF_TRIGGER_IDLE);
            session.setRepeatingRequest(builder.build(), preview_callback, background_handler);
            background_handler.postDelayed(focus_lock_expired, focus_lock_timeout_ms);
            runOnUiThread(() -> status.setText("focusing — hold still…"));
        } catch (Exception error) {
            focus_failed(error.toString());
        }
    }

    private void focus_failed(String reason)
    {
        awaiting_focus_lock = false;
        focus_lock.cancel();
        background_handler.removeCallbacks(focus_lock_expired);
        last_af_ok_ms = 0;
        capture_ready = false;
        last_capture_ms = SystemClock.elapsedRealtime();
        release_focus_lock();
        log("focus-lock-failed", reason);
        runOnUiThread(() -> status.setText("could not focus — move slightly farther away and hold still"));
        rearm();
    }

    private void focus_locked()
    {
        if (!awaiting_focus_lock)
            return;
        long now = SystemClock.elapsedRealtime();
        if (focus_for_auto && (!detection_ok || now - last_motion_ms <= settle_ms
                || now - last_box_motion_ms <= settle_ms)) {
            focus_failed("receipt moved while focusing");
            return;
        }
        awaiting_focus_lock = false;
        background_handler.removeCallbacks(focus_lock_expired);
        log("focus-lock", "converged in "
            + (SystemClock.elapsedRealtime() - focus_lock_started_ms) + "ms");
        capture_burst();
    }

    private final Runnable focus_lock_expired = () -> {
        if (!awaiting_focus_lock)
            return;
        focus_failed("no confirmed lock in " + focus_lock_timeout_ms + "ms");
    };

    // the lock has to be released or continuous AF stays frozen on the next
    // receipt, which reads as "the camera stopped focusing"
    private void release_focus_lock()
    {
        if (session == null || camera == null)
            return;
        try {
            CaptureRequest.Builder builder = camera.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW);
            builder.addTarget(preview_surface);
            apply_camera_controls(builder, capture_af_mode);
            builder.set(CaptureRequest.CONTROL_AF_TRIGGER, CaptureRequest.CONTROL_AF_TRIGGER_CANCEL);
            session.capture(builder.build(), preview_callback, background_handler);
            start_repeating();
        } catch (Exception error) {
            log("focus-release-failed", error.toString());
        }
    }

    // one trigger fires a burst; only the sharpest frame is uploaded, so a
    // tremor spike during any single exposure cannot ruin the shot
    private void capture_burst()
    {
        if (session == null || camera == null || burst_active)
            return;
        burst_active = true;
        try {
            CaptureRequest.Builder builder = camera.createCaptureRequest(CameraDevice.TEMPLATE_STILL_CAPTURE);
            builder.addTarget(reader.getSurface());
            apply_camera_controls(builder, capture_af_mode);
            builder.set(CaptureRequest.NOISE_REDUCTION_MODE, CaptureRequest.NOISE_REDUCTION_MODE_HIGH_QUALITY);
            builder.set(CaptureRequest.EDGE_MODE, CaptureRequest.EDGE_MODE_HIGH_QUALITY);
            builder.set(CaptureRequest.JPEG_ORIENTATION, sensor_orientation);
            builder.set(CaptureRequest.JPEG_QUALITY, (byte) 95);
            if (torch_on)
                builder.set(CaptureRequest.FLASH_MODE, CaptureRequest.FLASH_MODE_TORCH);

            // without the torch, pin the still to a 30fps frame budget so AE
            // cannot pick smear-length exposures — it raises ISO instead
            if (!torch_on && still_fps_range != null && preview_exposure_ns > 40_000_000L) {
                builder.set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, still_fps_range);
                log("fps-clamp", still_fps_range + " (preview exposure "
                    + (preview_exposure_ns / 1_000_000) + "ms)");
            }

            // dim rooms push AE to long exposures that smear handheld shots —
            // cap the still at ~20ms and buy the light back with ISO instead
            long exposure_ns = preview_exposure_ns;
            if (manual_sensor && exposure_ns > 20_000_000L && preview_iso > 0) {
                long target_ns = 20_000_000L;
                double required_iso = preview_iso * (exposure_ns / (double) target_ns);
                int iso;
                if (required_iso > max_iso) {
                    iso = max_iso;
                    target_ns = (long) (exposure_ns * (preview_iso / (double) max_iso));
                } else
                    iso = (int) required_iso;
                builder.set(CaptureRequest.CONTROL_AE_MODE, CaptureRequest.CONTROL_AE_MODE_OFF);
                builder.set(CaptureRequest.SENSOR_EXPOSURE_TIME, target_ns);
                builder.set(CaptureRequest.SENSOR_SENSITIVITY, iso);
                log("manual-exposure", (target_ns / 1_000_000) + "ms iso " + iso
                    + " (preview " + (exposure_ns / 1_000_000) + "ms iso " + preview_iso + ")");
            }
            // Most phones — this one included — do not advertise MANUAL_SENSOR,
            // so the clamp above never runs and AE is free to hand back a 30ms
            // handheld exposure. Asking for -1 EV buys back roughly half of it;
            // brighten_if_dark() puts the paper back to white afterwards.
            else if (!torch_on && ae_compensation_step > 0 && exposure_ns >= 20_000_000L) {
                int compensation = Math.max(ae_compensation_min,
                    (int) Math.round(-1.0 / ae_compensation_step));
                builder.set(CaptureRequest.CONTROL_AE_EXPOSURE_COMPENSATION, compensation);
                log("ae-compensation", compensation + " steps (preview "
                    + (exposure_ns / 1_000_000) + "ms iso " + preview_iso + ")");
            }
            // risky light (clamped short exposure at the ISO ceiling) buys an extra ticket
            burst_count = preview_exposure_ns > 40_000_000L ? 4 : 3;
            List<CaptureRequest> burst = new ArrayList<>();
            for (int i = 0; i < burst_count; i++)
                burst.add(builder.build());
            burst_completed = 0;
            burst_images_ready = false;
            burst_frames.clear();
            capture_trigger_ms = SystemClock.elapsedRealtime();
            session.captureBurst(burst, capture_callback, background_handler);
            runOnUiThread(() -> status.setText("capturing — hold still…"));
        } catch (Exception error) {
            burst_active = false;
            release_focus_lock();
            rearm();
            log("capture-failed", error.toString());
            runOnUiThread(() -> toast("capture failed: " + error.getMessage()));
        }
    }

    // short clamped exposures at the ISO ceiling come out dark — map the paper
    // back to white digitally; grain hides in the paper, sharpness is untouched
    private byte[] brighten_if_dark(byte[] jpeg)
    {
        int p95 = jpeg_p95(jpeg);
        if (p95 >= 190 || p95 <= 0)
            return jpeg;
        float gain = Math.min(2.2f, 225f / p95);
        BitmapFactory.Options options = new BitmapFactory.Options();
        options.inPreferredConfig = Bitmap.Config.RGB_565;
        Bitmap source = BitmapFactory.decodeByteArray(jpeg, 0, jpeg.length, options);
        if (source == null)
            return jpeg;
        Bitmap bright = Bitmap.createBitmap(source.getWidth(), source.getHeight(), Bitmap.Config.RGB_565);
        Canvas canvas = new Canvas(bright);
        Paint paint = new Paint();
        ColorMatrix matrix = new ColorMatrix();
        matrix.setScale(gain, gain, gain, 1f);
        paint.setColorFilter(new ColorMatrixColorFilter(matrix));
        canvas.drawBitmap(source, 0f, 0f, paint);
        source.recycle();
        ByteArrayOutputStream encoded = new ByteArrayOutputStream();
        bright.compress(Bitmap.CompressFormat.JPEG, 95, encoded);
        bright.recycle();
        log("brightened", "p95 " + p95 + " gain " + gain);
        return encoded.toByteArray();
    }

    private int jpeg_p95(byte[] jpeg)
    {
        BitmapFactory.Options options = new BitmapFactory.Options();
        options.inSampleSize = 8;
        Bitmap bitmap = BitmapFactory.decodeByteArray(jpeg, 0, jpeg.length, options);
        if (bitmap == null)
            return 0;
        int width = bitmap.getWidth();
        int height = bitmap.getHeight();
        int[] pixels = new int[width * height];
        bitmap.getPixels(pixels, 0, width, 0, 0, width, height);
        bitmap.recycle();
        int[] hist = new int[256];
        for (int pixel : pixels)
            hist[((pixel >> 16 & 0xFF) + ((pixel >> 8 & 0xFF) << 1) + (pixel & 0xFF)) >> 2]++;
        int remaining = Math.round(pixels.length * 0.05f);
        for (int i = 255; i >= 0; i--) {
            remaining -= hist[i];
            if (remaining <= 0)
                return i;
        }
        return 0;
    }

    private double sharpness(byte[] jpeg)
    {
        BitmapFactory.Options options = new BitmapFactory.Options();
        options.inSampleSize = 8;
        Bitmap bitmap = BitmapFactory.decodeByteArray(jpeg, 0, jpeg.length, options);
        if (bitmap == null)
            return 0;
        int width = bitmap.getWidth();
        int height = bitmap.getHeight();
        int[] pixels = new int[width * height];
        bitmap.getPixels(pixels, 0, width, 0, 0, width, height);
        bitmap.recycle();
        int[] lum = new int[width * height];
        for (int i = 0; i < pixels.length; i++) {
            int pixel = pixels[i];
            lum[i] = ((pixel >> 16 & 0xFF) + ((pixel >> 8 & 0xFF) << 1) + (pixel & 0xFF)) >> 2;
        }
        long sum = 0;
        long count = 0;
        for (int y = 1; y < height - 1; y++)
            for (int x = 1; x < width - 1; x++) {
                int at = y * width + x;
                int lap = 4 * lum[at] - lum[at - 1] - lum[at + 1] - lum[at - width] - lum[at + width];
                sum += (long) lap * lap;
                count++;
            }
        return sum / (double) count;
    }

    // A soft burst is soft all the way through — its three frames share one
    // lens position inside 400ms, so picking the best of them rescues nothing.
    // Upload anyway (the tool upgrades a receipt when a later photo of it
    // decodes) and take one more shot, which re-runs focus from scratch.
    private void keep_and_maybe_reshoot(byte[] jpeg, double score)
    {
        upload(brighten_if_dark(jpeg));
        if (score >= sharp_floor) {
            soft_retries = 0;
            return;
        }
        if (!auto_enabled || soft_retries > 0)
            return;
        soft_retries++;
        log("soft-reshoot", "score " + Math.round(score) + " below " + Math.round(sharp_floor));
        runOnUiThread(() -> status.setText("soft shot — hold still for one more…"));
        rearm();
    }

    private void finish_burst_if_ready()
    {
        if (burst_active && burst_images_ready && burst_completed >= burst_count) {
            burst_active = false;
            release_focus_lock();
        }
    }

    // feedback fires when the exposure has actually completed — the click means
    // "the photo exists, moving is safe", not an echo of the trigger
    private final CameraCaptureSession.CaptureCallback capture_callback =
        new CameraCaptureSession.CaptureCallback() {
            @Override
            public void onCaptureCompleted(CameraCaptureSession completed_session,
                CaptureRequest request, TotalCaptureResult result)
            {
                if (completed_session != session)
                    return;
                log("still-result", "exposure " + result.get(CaptureResult.SENSOR_EXPOSURE_TIME)
                    + "ns iso " + result.get(CaptureResult.SENSOR_SENSITIVITY)
                    + " af " + result.get(CaptureResult.CONTROL_AF_STATE)
                    + " focus " + result.get(CaptureResult.LENS_FOCUS_DISTANCE)
                    + " ois " + result.get(CaptureResult.LENS_OPTICAL_STABILIZATION_MODE));
                burst_completed++;
                if (burst_completed < burst_count)
                    return;
                log("capture-timing", "burst of " + burst_count + " done +"
                    + (SystemClock.elapsedRealtime() - capture_trigger_ms) + "ms after trigger");
                finish_burst_if_ready();
                runOnUiThread(() -> {
                    sound.play(MediaActionSound.SHUTTER_CLICK);
                    Vibrator vibrator = (Vibrator) getSystemService(VIBRATOR_SERVICE);
                    if (vibrator != null)
                        vibrator.vibrate(40);
                    flash_view.setAlpha(0.9f);
                    flash_view.animate().alpha(0f).setDuration(250).start();
                    if (auto_enabled)
                        status.setText("captured — move to the next receipt");
                });
            }

            @Override
            public void onCaptureFailed(CameraCaptureSession failed_session,
                CaptureRequest request, CaptureFailure failure)
            {
                if (failed_session != session)
                    return;
                burst_active = false;
                burst_frames.clear();
                release_focus_lock();
                log("capture-failed", "reason " + failure.getReason());
                runOnUiThread(() -> toast("capture failed"));
            }
        };

    // auto capture: shoot when focus has converged and the hand has been still,
    // then stay disarmed until the phone visibly moves to the next receipt

    private final CameraCaptureSession.CaptureCallback preview_callback =
        new CameraCaptureSession.CaptureCallback() {
            @Override
            public void onCaptureCompleted(CameraCaptureSession completed_session,
                CaptureRequest request, TotalCaptureResult result)
            {
                if (completed_session != session)
                    return;
                Integer af = result.get(CaptureResult.CONTROL_AF_STATE);
                boolean converged = capture_af_mode == CaptureRequest.CONTROL_AF_MODE_OFF
                    || (af != null && (af == CaptureResult.CONTROL_AF_STATE_PASSIVE_FOCUSED
                        || af == CaptureResult.CONTROL_AF_STATE_FOCUSED_LOCKED));
                last_af_ok_ms = converged ? SystemClock.elapsedRealtime() : 0;
                Long exposure = result.get(CaptureResult.SENSOR_EXPOSURE_TIME);
                if (exposure != null)
                    preview_exposure_ns = exposure;
                Integer iso = result.get(CaptureResult.SENSOR_SENSITIVITY);
                if (iso != null)
                    preview_iso = iso;
                FocusLock.Decision decision = focus_lock.result(request.getTag(), af);
                if (decision == FocusLock.Decision.CAPTURE)
                    focus_locked();
                else if (decision == FocusLock.Decision.FAIL)
                    focus_failed("autofocus reported NOT_FOCUSED_LOCKED");
                maybe_auto_capture();
            }
        };

    private final SensorEventListener sensor_listener = new SensorEventListener() {
        @Override
        public void onSensorChanged(SensorEvent event)
        {
            if (event.sensor.getType() == Sensor.TYPE_ACCELEROMETER) {
                gravity_x = gravity_x * 0.8f + event.values[0] * 0.2f;
                gravity_y = gravity_y * 0.8f + event.values[1] * 0.2f;
                return;
            }
            float magnitude = (float) Math.sqrt(event.values[0] * event.values[0]
                + event.values[1] * event.values[1] + event.values[2] * event.values[2]);
            boolean rotation = event.sensor.getType() == Sensor.TYPE_GYROSCOPE;
            // phone.log showed hand tremor tripping tight thresholds near-continuously;
            // box stability is the fine judge, this gate only catches real movement
            float moving = rotation ? 0.3f : 0.8f;
            if (magnitude > moving)
                last_motion_ms = SystemClock.elapsedRealtime();
        }

        @Override
        public void onAccuracyChanged(Sensor sensor, int accuracy) {}
    };

    private void maybe_auto_capture()
    {
        if (!auto_enabled || !auto_armed || session == null || !capture_ready || burst_active || awaiting_focus_lock)
            return;
        long now = SystemClock.elapsedRealtime();
        if (now - last_motion_ms <= settle_ms || now - last_box_motion_ms <= settle_ms)
            return;
        if (preview_af_mode == CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE && last_af_ok_ms == 0)
            return;
        if (now - last_capture_ms < 1500)
            return;
        auto_armed = false;
        last_capture_ms = now;
        log("auto-fire", "waited " + (now - armed_since_ms) + "ms since armed");
        capture(true);
    }

    // frame analysis: visual stillness (sensors miss constant-speed glides) and
    // receipt detection — the brightest blob must sit fully inside the view

    private final Runnable frame_watcher = new Runnable() {
        @Override
        public void run()
        {
            analyze_frame();
            ui_handler.postDelayed(this, 150);
        }
    };

    private void analyze_frame()
    {
        if (!texture_view.isAvailable() || session == null) {
            grid.set_detection(null, GridOverlay.state_red);
            return;
        }
        texture_view.getBitmap(frame_bitmap);
        frame_bitmap.getPixels(frame_pixels, 0, detect_w, 0, 0, detect_w, detect_h);
        for (int i = 0; i < frame_pixels.length; i++) {
            int pixel = frame_pixels[i];
            lum_current[i] = ((pixel >> 16 & 0xFF) + ((pixel >> 8 & 0xFF) << 1) + (pixel & 0xFF)) >> 2;
        }
        int[] swap = lum_previous;
        lum_previous = lum_current;
        lum_current = swap;
        lum_valid = true;

        detection_ok = detect_receipt(lum_previous);
        long now = SystemClock.elapsedRealtime();

        // stillness via box stability: the box aggregates thousands of pixels, so
        // sensor noise cannot move it — real drift can; temporal smoothing keeps
        // single-frame edge flicker (dim rooms) from resetting the steady timer
        if (!detection_ok || detect_box.isEmpty()) {
            last_box_motion_ms = now;
            steady_box.reset();
            smooth_box.setEmpty();
        } else {
            if (smooth_box.isEmpty())
                smooth_box.set(detect_box);
            else
                smooth_box.set(
                    (smooth_box.left + detect_box.left) / 2f,
                    (smooth_box.top + detect_box.top) / 2f,
                    (smooth_box.right + detect_box.right) / 2f,
                    (smooth_box.bottom + detect_box.bottom) / 2f);
            if (steady_box.moved(smooth_box.centerX(), smooth_box.centerY(),
                    smooth_box.width(), smooth_box.height()))
                last_box_motion_ms = now;
        }

        boolean still = now - last_motion_ms > settle_ms && now - last_box_motion_ms > settle_ms;
        boolean af_ok = preview_af_mode != CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE
            || (last_af_ok_ms != 0 && now - last_af_ok_ms < 1000);
        boolean level_ok = Math.abs(gravity_x) < 1.2f && Math.abs(gravity_y) < 1.2f;
        capture_ready = detection_ok && still && af_ok;

        // scanner semantics: one shot per receipt — locked until the receipt
        // leaves the view (or the box lands somewhere clearly different)
        if (detection_ok)
            last_detected_ms = now;
        if (capture_ready && auto_armed && !smooth_box.isEmpty()) {
            shot_center_x = smooth_box.centerX();
            shot_center_y = smooth_box.centerY();
        }
        if (auto_enabled && !auto_armed) {
            boolean receipt_gone = now - last_detected_ms > 400;
            boolean new_position = detection_ok && !smooth_box.isEmpty()
                && (Math.abs(smooth_box.centerX() - shot_center_x) > 0.25f
                    || Math.abs(smooth_box.centerY() - shot_center_y) > 0.25f);
            if (receipt_gone || new_position) {
                soft_retries = 0;
                rearm();
            }
        }

        grid.set_detection(smooth_box.isEmpty()
                ? (detect_box.isEmpty() ? null : detect_box) : smooth_box,
            !detection_ok ? GridOverlay.state_red
                : capture_ready && (auto_armed || !auto_enabled)
                    ? GridOverlay.state_green : GridOverlay.state_orange);
        boolean locked = auto_enabled && !auto_armed && session != null;
        grid.set_level(gravity_x, -gravity_y, level_ok, session != null && !locked);
        grid.set_saved(locked);

        // Real light beats gate patience: torch on when AE runs long exposures.
        // Both tests sit on a reported bucket rather than between two, and each
        // has to hold for a dwell — the torch shortens the very exposure the
        // tests read, so instant switching oscillates.
        long exposure_ms = preview_exposure_ns / 1_000_000;
        if (exposure_ms < torch_on_ms)
            torch_dim_since_ms = 0;
        else if (torch_dim_since_ms == 0)
            torch_dim_since_ms = now;
        if (exposure_ms > torch_off_ms)
            torch_bright_since_ms = 0;
        else if (torch_bright_since_ms == 0)
            torch_bright_since_ms = now;
        if (light_mode.equals("off"))
            set_torch(false);
        else if (light_mode.equals("on"))
            set_torch(true);
        else if (!torch_on && torch_dim_since_ms != 0 && now - torch_dim_since_ms > torch_dwell_ms)
            set_torch(true);
        else if (torch_on && torch_bright_since_ms != 0 && now - torch_bright_since_ms > torch_dwell_ms)
            set_torch(false);
        if (auto_enabled && auto_armed && session != null) {
            status.setText(coach_hint(level_ok));
            if (now - last_gate_log_ms > 2500) {
                last_gate_log_ms = now;
                log("auto-gate", "detected " + detection_ok + " af_age " + (now - last_af_ok_ms)
                    + "ms sensor " + (now - last_motion_ms) + "ms box " + (now - last_box_motion_ms)
                    + "ms cut t" + detect_cut_top + " b" + detect_cut_bottom + " l" + detect_cut_left
                    + " r" + detect_cut_right + " area " + Math.round(detect_area * 100)
                    + "% angle " + Math.round(detect_angle_deg) + " exposure "
                    + (preview_exposure_ns / 1_000_000) + "ms iso " + preview_iso);
            }
        }
    }

    // one hint at a time, most fundamental problem first
    private String coach_hint(boolean level_ok)
    {
        if (!detection_ok) {
            if (detect_box.isEmpty())
                return "point at the receipt";
            if (detect_cut_top && detect_cut_bottom)
                return "move farther away";
            if (detect_cut_top)
                return "shift toward the top";
            if (detect_cut_bottom)
                return "shift toward the bottom";
            if (detect_cut_left)
                return "shift left";
            if (detect_cut_right)
                return "shift right";
            return "fit the whole receipt in view";
        }
        if (!level_ok)
            return "hold the phone level over the receipt";
        if (detect_area < 0.12f)
            return "move closer";
        if (detect_angle_deg > 6f)
            return "turn the phone a bit left";
        if (detect_angle_deg < -6f)
            return "turn the phone a bit right";
        if (capture_ready)
            return "OK";
        if (!torch_on && preview_exposure_ns > 55_000_000L)
            return "dim — set light: on for sharper shots";
        return "hold steady…";
    }

    // threshold anchors on receipt-white (p95 brightness), and only the largest
    // connected bright blob competes — a global bounding box balloons on any
    // stray highlight and painted the box far bigger than the receipt
    private boolean detect_receipt(int[] lum)
    {
        int total = lum.length;
        int[] hist = new int[256];
        for (int value : lum)
            hist[value]++;

        int remaining = Math.round(total * 0.05f);
        int p95 = 255;
        for (int i = 255; i >= 0; i--) {
            remaining -= hist[i];
            if (remaining <= 0) {
                p95 = i;
                break;
            }
        }
        int half = total / 2;
        int p50 = 0;
        for (int i = 0; i < 256; i++) {
            half -= hist[i];
            if (half <= 0) {
                p50 = i;
                break;
            }
        }
        int threshold = Math.max(p95 - 30, 60);
        // the weak cutoff also anchors on the background level so dim rooms,
        // where receipt and table brightness compress together, still separate
        int weak = Math.max(Math.max(p95 - 55, p50 + 15), 50);

        Arrays.fill(detect_labels, 0);
        int best_count = 0;
        int best_min_x = 0;
        int best_max_x = -1;
        int best_min_y = 0;
        int best_max_y = -1;
        long best_sum_x = 0;
        long best_sum_y = 0;
        long best_sum_xx = 0;
        long best_sum_yy = 0;
        long best_sum_xy = 0;
        for (int start = 0; start < total; start++) {
            if (lum[start] <= threshold || detect_labels[start] != 0)
                continue;
            int top = 0;
            detect_stack[top++] = start;
            detect_labels[start] = 1;
            int count = 0;
            int min_x = detect_w;
            int max_x = -1;
            int min_y = detect_h;
            int max_y = -1;
            long sum_x = 0;
            long sum_y = 0;
            long sum_xx = 0;
            long sum_yy = 0;
            long sum_xy = 0;
            while (top > 0) {
                int at = detect_stack[--top];
                int x = at % detect_w;
                int y = at / detect_w;
                count++;
                if (x < min_x) min_x = x;
                if (x > max_x) max_x = x;
                if (y < min_y) min_y = y;
                if (y > max_y) max_y = y;
                sum_x += x;
                sum_y += y;
                sum_xx += (long) x * x;
                sum_yy += (long) y * y;
                sum_xy += (long) x * y;
                if (x > 0 && detect_labels[at - 1] == 0 && lum[at - 1] > threshold) {
                    detect_labels[at - 1] = 1;
                    detect_stack[top++] = at - 1;
                }
                if (x < detect_w - 1 && detect_labels[at + 1] == 0 && lum[at + 1] > threshold) {
                    detect_labels[at + 1] = 1;
                    detect_stack[top++] = at + 1;
                }
                if (y > 0 && detect_labels[at - detect_w] == 0 && lum[at - detect_w] > threshold) {
                    detect_labels[at - detect_w] = 1;
                    detect_stack[top++] = at - detect_w;
                }
                if (y < detect_h - 1 && detect_labels[at + detect_w] == 0 && lum[at + detect_w] > threshold) {
                    detect_labels[at + detect_w] = 1;
                    detect_stack[top++] = at + detect_w;
                }
            }
            if (count > best_count) {
                best_count = count;
                best_min_x = min_x;
                best_max_x = max_x;
                best_min_y = min_y;
                best_max_y = max_y;
                best_sum_x = sum_x;
                best_sum_y = sum_y;
                best_sum_xx = sum_xx;
                best_sum_yy = sum_yy;
                best_sum_xy = sum_xy;
            }
        }

        if (best_max_x < 0) {
            detect_box.setEmpty();
            return false;
        }

        // dense print (QR codes, totals) drags dim rows below the strong threshold;
        // grow the box while rows still read as receipt paper
        while (best_max_y + 1 < detect_h
            && row_is_paper(lum, best_min_x, best_max_x, best_max_y + 1, weak))
            best_max_y++;
        while (best_min_y - 1 >= 0
            && row_is_paper(lum, best_min_x, best_max_x, best_min_y - 1, weak))
            best_min_y--;

        detect_box.set(best_min_x / (float) detect_w, best_min_y / (float) detect_h,
            (best_max_x + 1) / (float) detect_w, (best_max_y + 1) / (float) detect_h);

        float area_ratio = best_count / (float) total;
        float fill = best_count
            / (float) ((best_max_x - best_min_x + 1) * (best_max_y - best_min_y + 1));
        detect_cut_left = best_min_x < 3;
        detect_cut_right = best_max_x > detect_w - 4;
        detect_cut_top = best_min_y < 3;
        detect_cut_bottom = best_max_y > detect_h - 4;
        detect_area = area_ratio;
        double mean_x = best_sum_x / (double) best_count;
        double mean_y = best_sum_y / (double) best_count;
        double sxx = best_sum_xx / (double) best_count - mean_x * mean_x;
        double syy = best_sum_yy / (double) best_count - mean_y * mean_y;
        double sxy = best_sum_xy / (double) best_count - mean_x * mean_y;
        detect_angle_deg = (float) Math.toDegrees(0.5 * Math.atan2(2 * sxy, syy - sxx));
        boolean inside = !detect_cut_left && !detect_cut_right && !detect_cut_top && !detect_cut_bottom;
        return inside && area_ratio >= 0.08f && area_ratio <= 0.9f && fill >= 0.5f;
    }

    private float bright_fraction(int[] lum, int min_x, int max_x, int y, int weak)
    {
        int bright = 0;
        for (int x = min_x; x <= max_x; x++)
            if (lum[y * detect_w + x] > weak)
                bright++;
        return bright / (float) (max_x - min_x + 1);
    }

    // a row is receipt if mostly bright (even light) or clearly brighter than the
    // background beside it — torch falloff dims paper ends below global thresholds
    private boolean row_is_paper(int[] lum, int min_x, int max_x, int y, int weak)
    {
        if (bright_fraction(lum, min_x, max_x, y, weak) > 0.35f)
            return true;
        int inside = 0;
        for (int x = min_x; x <= max_x; x++)
            inside += lum[y * detect_w + x];
        float inside_mean = inside / (float) (max_x - min_x + 1);
        int flank = 0;
        int flank_count = 0;
        for (int x = Math.max(0, min_x - 12); x <= min_x - 4; x++) {
            flank += lum[y * detect_w + x];
            flank_count++;
        }
        for (int x = max_x + 4; x <= Math.min(detect_w - 1, max_x + 12); x++) {
            flank += lum[y * detect_w + x];
            flank_count++;
        }
        return flank_count > 0 && inside_mean > flank / (float) flank_count + 20f;
    }

    private void rearm()
    {
        if (!auto_enabled || auto_armed)
            return;
        auto_armed = true;
        armed_since_ms = SystemClock.elapsedRealtime();
    }

    // upload

    private void upload(byte[] jpeg)
    {
        runOnUiThread(() -> status.setText("uploading…"));
        new Thread(() -> {
            try {
                HttpURLConnection connection =
                    (HttpURLConnection) new URL(server() + "/upload").openConnection();
                connection.setDoOutput(true);
                connection.setRequestMethod("POST");
                connection.setRequestProperty("Content-Type", "image/jpeg");
                connection.setFixedLengthStreamingMode(jpeg.length);
                OutputStream out = connection.getOutputStream();
                out.write(jpeg);
                out.close();
                int code = connection.getResponseCode();
                String body = read_body(connection);
                connection.disconnect();
                if (code != 200)
                    throw new Exception("http " + code);
                String saved = extract(body, "\"saved\":\"", "\"");
                String kb = extract(body, "\"kb\":", "}");
                saved_count += 1;
                runOnUiThread(() -> {
                    toast("saved " + saved + " · " + kb + " kB");
                    status.setText(saved_count + (auto_enabled
                        ? " saved — show the next receipt" : " saved this session"));
                });
            } catch (Exception error) {
                log("upload-failed", error.toString());
                runOnUiThread(() -> {
                    toast("upload failed: " + error.getMessage());
                    status.setText("upload failed — check server address");
                });
            }
        }).start();
    }

    private String read_body(HttpURLConnection connection) throws Exception
    {
        BufferedReader reader_in = new BufferedReader(new InputStreamReader(connection.getInputStream()));
        StringBuilder out = new StringBuilder();
        String line;
        while ((line = reader_in.readLine()) != null)
            out.append(line);
        reader_in.close();
        return out.toString();
    }

    private String extract(String body, String prefix, String suffix)
    {
        int start = body.indexOf(prefix);
        if (start < 0)
            return "?";
        start += prefix.length();
        int end = body.indexOf(suffix, start);
        return end < 0 ? "?" : body.substring(start, end);
    }

    // server address preference

    private String server()
    {
        return prefs().getString("server", default_server);
    }

    private SharedPreferences prefs()
    {
        return getSharedPreferences("receiptdrop", MODE_PRIVATE);
    }

    private void show_server_dialog()
    {
        EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
        input.setText(server());
        new AlertDialog.Builder(this)
            .setTitle("Server address")
            .setView(input)
            .setPositiveButton("Save", (dialog, which) -> {
                String value = input.getText().toString().trim();
                while (value.endsWith("/"))
                    value = value.substring(0, value.length() - 1);
                prefs().edit().putString("server", value).apply();
                toast("server: " + server());
            })
            .setNegativeButton("Cancel", null)
            .show();
    }

    // helpers

    private void toast(String message)
    {
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show();
    }

    private int dp(int value)
    {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private void log(String event, String detail)
    {
        new Thread(() -> {
            try {
                HttpURLConnection connection =
                    (HttpURLConnection) new URL(server() + "/client-log").openConnection();
                connection.setDoOutput(true);
                connection.setRequestMethod("POST");
                connection.setRequestProperty("Content-Type", "application/json");
                String json = "{\"version\":\"" + app_version + "\",\"event\":\"" + escape(event)
                    + "\",\"detail\":\"" + escape(detail) + "\"}";
                OutputStream out = connection.getOutputStream();
                out.write(json.getBytes("UTF-8"));
                out.close();
                connection.getResponseCode();
                connection.disconnect();
            } catch (Exception ignored) {}
        }).start();
    }

    private String escape(String value)
    {
        return value.replace("\\", "\\\\").replace("\"", "\\\"");
    }
}
