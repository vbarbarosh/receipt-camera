package app.receiptcamera;

// Compare with a retained anchor so sub-threshold frame-to-frame drift adds up.
final class SteadyBox
{
    private final float shift;
    private final float grow;
    private boolean valid;
    private float x, y, width, height;

    SteadyBox(float shift, float grow)
    {
        this.shift = shift;
        this.grow = grow;
    }

    void reset()
    {
        valid = false;
    }

    boolean moved(float x, float y, float width, float height)
    {
        if (valid && Math.abs(this.x - x) <= shift && Math.abs(this.y - y) <= shift
            && Math.abs(this.width - width) <= grow && Math.abs(this.height - height) <= grow)
            return false;
        this.x = x;
        this.y = y;
        this.width = width;
        this.height = height;
        valid = true;
        return true;
    }
}
