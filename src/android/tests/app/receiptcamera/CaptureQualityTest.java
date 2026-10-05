package app.receiptcamera;

import android.hardware.camera2.CaptureResult;

public final class CaptureQualityTest
{
    private static int checks;

    private static void check(boolean condition, String message)
    {
        checks++;
        if (!condition)
            throw new AssertionError(message);
    }

    public static void main(String[] args)
    {
        FocusLock lock = new FocusLock();
        Object first = lock.begin();
        check(lock.result(null, CaptureResult.CONTROL_AF_STATE_FOCUSED_LOCKED)
            == FocusLock.Decision.WAIT, "untagged preview must not complete a shot");
        for (Integer state : new Integer[] {null, CaptureResult.CONTROL_AF_STATE_INACTIVE,
                CaptureResult.CONTROL_AF_STATE_ACTIVE_SCAN, CaptureResult.CONTROL_AF_STATE_PASSIVE_SCAN,
                CaptureResult.CONTROL_AF_STATE_PASSIVE_FOCUSED, CaptureResult.CONTROL_AF_STATE_PASSIVE_UNFOCUSED})
            check(lock.result(first, state) == FocusLock.Decision.WAIT,
                "unconfirmed lock must wait: " + state);
        check(lock.result(first, CaptureResult.CONTROL_AF_STATE_NOT_FOCUSED_LOCKED)
            == FocusLock.Decision.FAIL, "failed autofocus must never capture");
        Object second = lock.begin();
        check(lock.result(first, CaptureResult.CONTROL_AF_STATE_FOCUSED_LOCKED)
            == FocusLock.Decision.WAIT, "late previous-shot result must be ignored");
        check(lock.result(second, CaptureResult.CONTROL_AF_STATE_FOCUSED_LOCKED)
            == FocusLock.Decision.CAPTURE, "confirmed current lock must capture");
        check(lock.result(second, CaptureResult.CONTROL_AF_STATE_FOCUSED_LOCKED)
            == FocusLock.Decision.WAIT, "one lock must only capture once");
        Object third = lock.begin();
        lock.cancel(); // timeout, exception, or closing the camera
        check(lock.result(third, CaptureResult.CONTROL_AF_STATE_FOCUSED_LOCKED)
            == FocusLock.Decision.WAIT, "cancelled shot must not capture later");

        SteadyBox box = new SteadyBox(0.010f, 0.020f);
        check(box.moved(0.5f, 0.5f, 0.3f, 0.7f), "first detection starts settling");
        check(!box.moved(0.504f, 0.5f, 0.3f, 0.7f), "small jitter is tolerated");
        check(!box.moved(0.508f, 0.5f, 0.3f, 0.7f), "drift below threshold can settle");
        check(box.moved(0.512f, 0.5f, 0.3f, 0.7f), "accumulated slow drift resets settling");
        check(!box.moved(0.512f, 0.5f, 0.31f, 0.7f), "small scale jitter is tolerated");
        check(box.moved(0.512f, 0.5f, 0.325f, 0.7f), "accumulated scale change resets settling");
        box.reset();
        check(box.moved(0.512f, 0.5f, 0.325f, 0.7f), "reappearing receipt must settle again");
        System.out.println("Passed " + checks + " capture quality checks");
    }
}
