package app.receiptdrop;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.RectF;
import android.view.View;

// rule-of-thirds grid plus the receipt-detection box drawn over the camera preview
public class GridOverlay extends View
{
    public static final int state_red = 0;
    public static final int state_orange = 1;
    public static final int state_green = 2;

    private final RectF box = new RectF();
    private final Paint box_paint = new Paint();
    private int box_state = state_red;
    private boolean box_visible = false;
    private boolean bubble_ok = false;
    private final Paint bubble_paint = new Paint();
    private boolean bubble_visible = false;
    private float bubble_x = 0f;
    private float bubble_y = 0f;
    private final Paint check_paint = new Paint();
    private final float density;
    private final Paint dot_paint = new Paint();
    private final Paint grid_paint = new Paint();
    private final Paint saved_paint = new Paint();
    private boolean saved_visible = false;

    public GridOverlay(Context context)
    {
        super(context);
        density = context.getResources().getDisplayMetrics().density;
        grid_paint.setColor(0x59FFFFFF);
        grid_paint.setStrokeWidth(density);
        box_paint.setStyle(Paint.Style.STROKE);
        box_paint.setStrokeWidth(3f * density);
        bubble_paint.setStyle(Paint.Style.STROKE);
        saved_paint.setStyle(Paint.Style.FILL);
        saved_paint.setColor(0xE633CC66);
        check_paint.setStyle(Paint.Style.STROKE);
        check_paint.setStrokeWidth(5f * density);
        check_paint.setStrokeCap(Paint.Cap.ROUND);
        check_paint.setColor(0xFFFFFFFF);
    }

    public void set_saved(boolean visible)
    {
        saved_visible = visible;
        invalidate();
    }

    public void set_level(float offset_x, float offset_y, boolean ok, boolean visible)
    {
        bubble_x = offset_x;
        bubble_y = offset_y;
        bubble_ok = ok;
        bubble_visible = visible;
        invalidate();
    }

    public void set_detection(RectF normalized, int state)
    {
        box_visible = normalized != null;
        if (normalized != null)
            box.set(normalized);
        box_state = state;
        invalidate();
    }

    @Override
    protected void onDraw(Canvas canvas)
    {
        float width = getWidth();
        float height = getHeight();
        for (int i = 1; i <= 2; i++) {
            canvas.drawLine(width * i / 3f, 0f, width * i / 3f, height, grid_paint);
            canvas.drawLine(0f, height * i / 3f, width, height * i / 3f, grid_paint);
        }
        if (box_visible) {
            box_paint.setColor(box_state == state_green ? 0xCC33CC66
                : box_state == state_orange ? 0xCCE8A33D : 0xCCE05050);
            canvas.drawRect(box.left * width, box.top * height,
                box.right * width, box.bottom * height, box_paint);
        }
        if (saved_visible) {
            float cx = width / 2f;
            float cy = height / 2f;
            canvas.drawCircle(cx, cy, 34f * density, saved_paint);
            canvas.drawLine(cx - 14f * density, cy + 1f * density,
                cx - 4f * density, cy + 12f * density, check_paint);
            canvas.drawLine(cx - 4f * density, cy + 12f * density,
                cx + 15f * density, cy - 11f * density, check_paint);
        }
        if (bubble_visible) {
            float cx = width / 2f;
            float cy = height / 2f;
            float radius = 30f * density;
            // dark under white ring, outlined dot: visible on white paper and dark wood alike
            bubble_paint.setStrokeWidth(3f * density);
            bubble_paint.setColor(0x88000000);
            canvas.drawCircle(cx, cy, radius, bubble_paint);
            canvas.drawCircle(cx, cy, 4f * density, bubble_paint);
            bubble_paint.setStrokeWidth(1.5f * density);
            bubble_paint.setColor(0xAAFFFFFF);
            canvas.drawCircle(cx, cy, radius, bubble_paint);
            canvas.drawCircle(cx, cy, 4f * density, bubble_paint);
            float dx = Math.max(-radius, Math.min(radius, bubble_x * radius / 3f));
            float dy = Math.max(-radius, Math.min(radius, bubble_y * radius / 3f));
            dot_paint.setStyle(Paint.Style.FILL);
            dot_paint.setColor(bubble_ok ? 0xEE33CC66 : 0xEEE8A33D);
            canvas.drawCircle(cx + dx, cy + dy, 6f * density, dot_paint);
            dot_paint.setStyle(Paint.Style.STROKE);
            dot_paint.setStrokeWidth(1.5f * density);
            dot_paint.setColor(0x88000000);
            canvas.drawCircle(cx + dx, cy + dy, 6f * density, dot_paint);
        }
    }
}
