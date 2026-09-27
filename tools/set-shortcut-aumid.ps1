<#
Writes System.AppUserModel.ID onto a Start-menu shortcut via IPropertyStore.

Windows attributes a toast by looking up the shortcut whose AUMID matches the
toast's; with no such shortcut it prints the raw AUMID string as the app name.
WScript.Shell cannot set this property, hence the COM interop below.
#>
param(
  [Parameter(Mandatory = $true)][string]$ShortcutPath,
  [Parameter(Mandatory = $true)][string]$AppUserModelId,
  [string]$IconPath = ''
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $ShortcutPath)) {
  throw "shortcut not found: $ShortcutPath"
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class DshShortcutAumid {
    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    public struct PropertyKey {
        public Guid fmtid;
        public uint pid;
        public PropertyKey(Guid f, uint p) { fmtid = f; pid = p; }
    }

    // PROPVARIANT is 8-byte aligned: `vt` is followed by three reserved shorts
    // before the payload. The common `ushort vt; IntPtr p;` shape reads the payload
    // from the wrong offset and reports a successfully written property as absent.
    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    public struct PropVariant {
        public ushort vt;
        public ushort r1;
        public ushort r2;
        public ushort r3;
        public IntPtr pointerValue;
        public IntPtr pointerValue2;
    }

    [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
    public class ShellLink { }

    [ComImport, Guid("000214F9-0000-0000-C000-000000000046"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IShellLinkW {
        void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder f, int c, IntPtr fd, uint fl);
        void GetIDList(out IntPtr pidl);
        void SetIDList(IntPtr pidl);
        void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder n, int c);
        void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string n);
        void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder f, int c);
        void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string f);
        void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder f, int c);
        void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string f);
        void GetHotkey(out short h);
        void SetHotkey(short h);
        void GetShowCmd(out int i);
        void SetShowCmd(int i);
        void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder i, int c, out int idx);
        void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string i, int idx);
        void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string p, uint r);
        void Resolve(IntPtr hwnd, uint flags);
        void SetPath([MarshalAs(UnmanagedType.LPWStr)] string p);
    }

    [ComImport, Guid("0000010b-0000-0000-C000-000000000046"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IPersistFile {
        void GetClassID(out Guid pClassID);
        void IsDirty();
        void Load([MarshalAs(UnmanagedType.LPWStr)] string fileName, uint mode);
        void Save([MarshalAs(UnmanagedType.LPWStr)] string fileName, bool remember);
        void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string fileName);
        void GetCurFile([MarshalAs(UnmanagedType.LPWStr)] out string fileName);
    }

    [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IPropertyStore {
        void GetCount(out uint count);
        void GetAt(uint index, out PropertyKey key);
        void GetValue(ref PropertyKey key, out PropVariant value);
        void SetValue(ref PropertyKey key, ref PropVariant value);
        void Commit();
    }

    [DllImport("ole32.dll")]
    private static extern int PropVariantClear(ref PropVariant pvar);

    /// <summary>Write System.AppUserModel.ID onto a shortcut, in place.</summary>
    public static void SetAumid(string shortcutPath, string aumid) {
        var link = (IShellLinkW)new ShellLink();
        var file = (IPersistFile)link;
        file.Load(shortcutPath, 2 /* STGM_READWRITE */);

        var store = (IPropertyStore)link;
        var key = new PropertyKey(new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), 5);
        var value = new PropVariant();
        value.vt = 31; // VT_LPWSTR
        value.pointerValue = Marshal.StringToCoTaskMemUni(aumid);
        try {
            store.SetValue(ref key, ref value);
            store.Commit();
        } finally {
            PropVariantClear(ref value);
        }

        file.Save(shortcutPath, true);
        Marshal.ReleaseComObject(store);
        Marshal.ReleaseComObject(file);
    }

    /// <summary>Read System.AppUserModel.ID back, for verification.</summary>
    public static string GetAumid(string shortcutPath) {
        var link = (IShellLinkW)new ShellLink();
        var file = (IPersistFile)link;
        file.Load(shortcutPath, 0 /* STGM_READ */);
        var store = (IPropertyStore)link;
        var key = new PropertyKey(new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), 5);
        PropVariant value;
        store.GetValue(ref key, out value);
        string result = value.vt == 31 && value.pointerValue != IntPtr.Zero
            ? Marshal.PtrToStringUni(value.pointerValue)
            : null;
        PropVariantClear(ref value);
        Marshal.ReleaseComObject(store);
        Marshal.ReleaseComObject(file);
        return result;
    }
}
'@

$before = [DshShortcutAumid]::GetAumid($ShortcutPath)
Write-Output "before AUMID : $(if ($before) { $before } else { '(none)' })"

[DshShortcutAumid]::SetAumid($ShortcutPath, $AppUserModelId)
$after = [DshShortcutAumid]::GetAumid($ShortcutPath)
Write-Output "after AUMID  : $(if ($after) { $after } else { '(none)' })"

if ($after -ne $AppUserModelId) {
  throw "verification failed: expected '$AppUserModelId', read back '$after'"
}

if ($IconPath -and (Test-Path -LiteralPath $IconPath)) {
  $shell = New-Object -ComObject WScript.Shell
  $link = $shell.CreateShortcut($ShortcutPath)
  $link.IconLocation = "$IconPath,0"
  $link.Save()
  Write-Output "icon set     : $IconPath"
}

Write-Output 'OK'
