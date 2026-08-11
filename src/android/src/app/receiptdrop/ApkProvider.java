package app.receiptdrop;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import java.io.File;
import java.io.FileNotFoundException;

// serves the downloaded update.apk from cache to the system package installer
public class ApkProvider extends ContentProvider
{
    @Override
    public boolean onCreate()
    {
        return true;
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException
    {
        File apk = new File(getContext().getCacheDir(), "update.apk");
        return ParcelFileDescriptor.open(apk, ParcelFileDescriptor.MODE_READ_ONLY);
    }

    @Override
    public String getType(Uri uri)
    {
        return "application/vnd.android.package-archive";
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] args, String order)
    {
        return null;
    }

    @Override
    public Uri insert(Uri uri, ContentValues values)
    {
        return null;
    }

    @Override
    public int delete(Uri uri, String selection, String[] args)
    {
        return 0;
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] args)
    {
        return 0;
    }
}
