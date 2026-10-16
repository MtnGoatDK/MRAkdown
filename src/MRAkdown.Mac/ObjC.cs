using System.Collections.Concurrent;
using System.Runtime.InteropServices;

namespace MRAkdown;

[StructLayout(LayoutKind.Sequential)]
struct CGPoint(double x, double y)
{
    public double X = x;
    public double Y = y;
}

[StructLayout(LayoutKind.Sequential)]
struct CGSize(double width, double height)
{
    public double Width = width;
    public double Height = height;
}

[StructLayout(LayoutKind.Sequential)]
struct CGRect(double x, double y, double width, double height)
{
    public CGPoint Origin = new(x, y);
    public CGSize Size = new(width, height);
}

/// <summary>
/// Calls AppKit and WebKit through the Objective-C runtime: objc_msgSend with a fixed signature for each shape of call,
/// and classes defined at run time whose methods are C# functions. This needs no macOS workload or Xcode, so the
/// macOS host builds anywhere.
/// </summary>
static unsafe class ObjC
{
    const string LibObjC = "/usr/lib/libobjc.A.dylib";

    static readonly IntPtr s_lib = NativeLibrary.Load(LibObjC);
    static readonly IntPtr s_msgSend = NativeLibrary.GetExport(s_lib, "objc_msgSend");
    static readonly IntPtr s_msgSendSuper = NativeLibrary.GetExport(s_lib, "objc_msgSendSuper");
    // A struct over 16 bytes (CGRect) comes back through a hidden pointer on x64, which needs the _stret variant;
    // arm64 has no such variant.
    static readonly IntPtr s_msgSendStret = RuntimeInformation.ProcessArchitecture == Architecture.X64
        ? NativeLibrary.GetExport(s_lib, "objc_msgSend_stret")
        : s_msgSend;

    static readonly ConcurrentDictionary<string, IntPtr> s_selectors = new();
    static readonly ConcurrentDictionary<string, IntPtr> s_classes = new();

    [DllImport(LibObjC)] static extern IntPtr objc_getClass(string name);
    [DllImport(LibObjC)] static extern IntPtr objc_getProtocol(string name);
    [DllImport(LibObjC)] static extern IntPtr sel_registerName(string name);
    [DllImport(LibObjC)] static extern IntPtr objc_allocateClassPair(IntPtr superclass, string name, nint extraBytes);
    [DllImport(LibObjC)] static extern void objc_registerClassPair(IntPtr cls);
    [DllImport(LibObjC)] static extern byte class_addMethod(IntPtr cls, IntPtr sel, IntPtr imp, string types);
    [DllImport(LibObjC)] static extern byte class_addProtocol(IntPtr cls, IntPtr protocol);
    [DllImport(LibObjC)] static extern IntPtr objc_autoreleasePoolPush();
    [DllImport(LibObjC)] static extern void objc_autoreleasePoolPop(IntPtr pool);

    /// <summary>Loads the system frameworks whose classes are used; call before anything else.</summary>
    public static void LoadFrameworks()
    {
        foreach (var name in new[] { "AppKit", "WebKit", "UniformTypeIdentifiers" })
            NativeLibrary.Load($"/System/Library/Frameworks/{name}.framework/{name}");
    }

    public static IntPtr Sel(string name) => s_selectors.GetOrAdd(name, sel_registerName);

    public static IntPtr Class(string name) => s_classes.GetOrAdd(name, n =>
        objc_getClass(n) is var cls && cls != 0 ? cls : throw new InvalidOperationException($"No Objective-C class {n}"));

    /// <summary>[[name alloc] init], owned by the caller.</summary>
    public static IntPtr New(string name) => Send(Send(Class(name), "alloc"), "init");

    public static bool RespondsTo(IntPtr obj, string sel) => SendBool(obj, "respondsToSelector:", Sel(sel));

    /* ---------- objc_msgSend, one overload per shape of call ---------- */

    public static IntPtr Send(IntPtr obj, string sel) =>
        ((delegate* unmanaged<IntPtr, IntPtr, IntPtr>)s_msgSend)(obj, Sel(sel));

    public static IntPtr Send(IntPtr obj, string sel, IntPtr a) =>
        ((delegate* unmanaged<IntPtr, IntPtr, IntPtr, IntPtr>)s_msgSend)(obj, Sel(sel), a);

    public static IntPtr Send(IntPtr obj, string sel, IntPtr a, IntPtr b) =>
        ((delegate* unmanaged<IntPtr, IntPtr, IntPtr, IntPtr, IntPtr>)s_msgSend)(obj, Sel(sel), a, b);

    public static IntPtr Send(IntPtr obj, string sel, IntPtr a, IntPtr b, IntPtr c) =>
        ((delegate* unmanaged<IntPtr, IntPtr, IntPtr, IntPtr, IntPtr, IntPtr>)s_msgSend)(obj, Sel(sel), a, b, c);

    public static IntPtr Send(IntPtr obj, string sel, IntPtr a, IntPtr b, IntPtr c, IntPtr d) =>
        ((delegate* unmanaged<IntPtr, IntPtr, IntPtr, IntPtr, IntPtr, IntPtr, IntPtr>)s_msgSend)(obj, Sel(sel), a, b, c, d);

    public static IntPtr Send(IntPtr obj, string sel, CGRect rect, IntPtr a) =>
        ((delegate* unmanaged<IntPtr, IntPtr, CGRect, IntPtr, IntPtr>)s_msgSend)(obj, Sel(sel), rect, a);

    public static IntPtr Send(IntPtr obj, string sel, CGRect rect, IntPtr a, IntPtr b, IntPtr c) =>
        ((delegate* unmanaged<IntPtr, IntPtr, CGRect, IntPtr, IntPtr, IntPtr, IntPtr>)s_msgSend)(obj, Sel(sel), rect, a, b, c);

    public static IntPtr Send(IntPtr obj, string sel, CGPoint point, IntPtr a) =>
        ((delegate* unmanaged<IntPtr, IntPtr, CGPoint, IntPtr, IntPtr>)s_msgSend)(obj, Sel(sel), point, a);

    // Objective-C's BOOL is one byte.
    public static bool SendBool(IntPtr obj, string sel) =>
        ((delegate* unmanaged<IntPtr, IntPtr, byte>)s_msgSend)(obj, Sel(sel)) != 0;

    public static bool SendBool(IntPtr obj, string sel, IntPtr a) =>
        ((delegate* unmanaged<IntPtr, IntPtr, IntPtr, byte>)s_msgSend)(obj, Sel(sel), a) != 0;

    public static CGPoint SendPoint(IntPtr obj, string sel) =>
        ((delegate* unmanaged<IntPtr, IntPtr, CGPoint>)s_msgSend)(obj, Sel(sel));

    public static CGPoint SendPoint(IntPtr obj, string sel, CGPoint point) =>
        ((delegate* unmanaged<IntPtr, IntPtr, CGPoint, CGPoint>)s_msgSend)(obj, Sel(sel), point);

    public static CGRect SendRect(IntPtr obj, string sel) =>
        ((delegate* unmanaged<IntPtr, IntPtr, CGRect>)s_msgSendStret)(obj, Sel(sel));

    [StructLayout(LayoutKind.Sequential)]
    struct Super
    {
        public IntPtr Receiver;
        public IntPtr SuperClass;
    }

    /// <summary>Calls the superclass's implementation of a method, from an override.</summary>
    public static void SendSuper(IntPtr obj, IntPtr superclass, string sel, IntPtr a, IntPtr b)
    {
        var super = new Super { Receiver = obj, SuperClass = superclass };
        ((delegate* unmanaged<Super*, IntPtr, IntPtr, IntPtr, void>)s_msgSendSuper)(&super, Sel(sel), a, b);
    }

    /* ---------- Foundation values ---------- */

    /// <summary>An autoreleased NSString.</summary>
    public static IntPtr NSString(string s)
    {
        fixed (char* chars = s) return Send(Class("NSString"), "stringWithCharacters:length:", (IntPtr)chars, s.Length);
    }

    public static string? FromNSString(IntPtr s) => s == 0 ? null : Marshal.PtrToStringUTF8(Send(s, "UTF8String"));

    public static IntPtr NSNumber(bool value) => Send(Class("NSNumber"), "numberWithBool:", value ? 1 : 0);

    public static IntPtr FileUrl(string path) => Send(Class("NSURL"), "fileURLWithPath:", NSString(path));

    public static byte[] FromNSData(IntPtr data)
    {
        var length = (int)Send(data, "length");
        var bytes = new byte[length];
        if (length > 0) Marshal.Copy(Send(data, "bytes"), bytes, 0, length);
        return bytes;
    }

    public static IntPtr NSData(byte[] bytes)
    {
        fixed (byte* p = bytes) return Send(Class("NSData"), "dataWithBytes:length:", (IntPtr)p, bytes.Length);
    }

    /// <summary>The items of an NSArray.</summary>
    public static IEnumerable<IntPtr> Items(IntPtr array)
    {
        var count = array == 0 ? 0 : (int)Send(array, "count");
        for (var i = 0; i < count; i++) yield return Send(array, "objectAtIndex:", i);
    }

    /* ---------- Classes defined at run time, blocks, callbacks ---------- */

    /// <summary>Defines and registers a class whose methods are C# functions ([UnmanagedCallersOnly] pointers).</summary>
    /// <param name="types">Each method's Objective-C type encoding, e.g. "v@:@" for a void method with one object.</param>
    public static IntPtr DefineClass(string name, string superclass, string[] protocols,
        params (string Selector, IntPtr Imp, string Types)[] methods)
    {
        var cls = objc_allocateClassPair(Class(superclass), name, 0);
        if (cls == 0) throw new InvalidOperationException($"Objective-C class {name} already exists");
        foreach (var protocol in protocols)
        {
            if (objc_getProtocol(protocol) is var p && p != 0) class_addProtocol(cls, p);
        }
        foreach (var (selector, imp, types) in methods) class_addMethod(cls, Sel(selector), imp, types);
        objc_registerClassPair(cls);
        return cls;
    }

    // A block starts with isa, flags and reserved fields, then the function that runs it, which takes the block first.
    public static void InvokeBlock(IntPtr block) =>
        ((delegate* unmanaged<IntPtr, void>)*(IntPtr*)(block + 16))(block);

    public static void InvokeBlock(IntPtr block, IntPtr arg) =>
        ((delegate* unmanaged<IntPtr, IntPtr, void>)*(IntPtr*)(block + 16))(block, arg);

    /// <summary>
    /// Runs C# code called from Objective-C: in an autorelease pool, and with exceptions logged rather than
    /// crashing the app (they can't cross into Objective-C).
    /// </summary>
    public static void Callback(Action action)
    {
        var pool = objc_autoreleasePoolPush();
        try
        {
            action();
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(ex);
        }
        finally
        {
            objc_autoreleasePoolPop(pool);
        }
    }

    public static T Callback<T>(Func<T> func, T fallback)
    {
        var result = fallback;
        Callback(() => result = func());
        return result;
    }
}

/// <summary>Runs async continuations (and anything posted) on the main thread, through the main dispatch queue.</summary>
sealed unsafe class MainThreadContext : SynchronizationContext
{
    const string LibSystem = "/usr/lib/libSystem.B.dylib";

    // dispatch_get_main_queue() is a macro for the address of this symbol.
    static readonly IntPtr s_mainQueue = NativeLibrary.GetExport(NativeLibrary.Load(LibSystem), "_dispatch_main_q");
    readonly int _mainThread = Environment.CurrentManagedThreadId;

    [DllImport(LibSystem)]
    static extern void dispatch_async_f(IntPtr queue, IntPtr context, delegate* unmanaged<IntPtr, void> work);

    public override void Post(SendOrPostCallback d, object? state) =>
        dispatch_async_f(s_mainQueue, GCHandle.ToIntPtr(GCHandle.Alloc((d, state))), &Run);

    public override void Send(SendOrPostCallback d, object? state)
    {
        if (Environment.CurrentManagedThreadId == _mainThread)
        {
            d(state);
            return;
        }
        using var done = new ManualResetEventSlim();
        Post(_ =>
        {
            try { d(state); }
            finally { done.Set(); }
        }, null);
        done.Wait();
    }

    public override SynchronizationContext CreateCopy() => this;

    [UnmanagedCallersOnly]
    static void Run(IntPtr context)
    {
        var handle = GCHandle.FromIntPtr(context);
        var (d, state) = ((SendOrPostCallback, object?))handle.Target!;
        handle.Free();
        ObjC.Callback(() => d(state));
    }
}
