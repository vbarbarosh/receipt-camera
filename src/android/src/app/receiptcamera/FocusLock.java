package app.receiptcamera;

import android.hardware.camera2.CaptureResult;

// Camera-thread state; a new tag prevents queued results from an older
// preview/shot from completing the current focus attempt.
final class FocusLock
{
    enum Decision { WAIT, CAPTURE, FAIL }

    private Object tag;

    Object begin()
    {
        tag = new Object();
        return tag;
    }

    void cancel()
    {
        tag = null;
    }

    Decision result(Object request_tag, Integer state)
    {
        if (tag == null || request_tag != tag || state == null)
            return Decision.WAIT;
        if (state == CaptureResult.CONTROL_AF_STATE_FOCUSED_LOCKED) {
            cancel();
            return Decision.CAPTURE;
        }
        if (state == CaptureResult.CONTROL_AF_STATE_NOT_FOCUSED_LOCKED) {
            cancel();
            return Decision.FAIL;
        }
        return Decision.WAIT;
    }
}
