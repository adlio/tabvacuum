"""Native XTest keys for an isolated Linux browser-test DISPLAY only."""
import ctypes
import os
import sys
import time

if not os.environ.get("DISPLAY", "").startswith(":"):
    raise SystemExit("An isolated local DISPLAY is required")
x11 = ctypes.CDLL("libX11.so.6")
xtst = ctypes.CDLL("libXtst.so.6")
x11.XOpenDisplay.restype = ctypes.c_void_p
x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
x11.XStringToKeysym.argtypes = [ctypes.c_char_p]
x11.XStringToKeysym.restype = ctypes.c_ulong
x11.XKeysymToKeycode.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
x11.XKeysymToKeycode.restype = ctypes.c_uint
x11.XFlush.argtypes = [ctypes.c_void_p]
x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
xtst.XTestFakeKeyEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
display = x11.XOpenDisplay(None)
if not display:
    raise SystemExit("Cannot open test display")
try:
    if '--focus-title' in sys.argv:
        index = sys.argv.index('--focus-title')
        title = sys.argv[index + 1]
        del sys.argv[index:index + 2]
        x11.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
        x11.XDefaultRootWindow.restype = ctypes.c_ulong
        x11.XQueryTree.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.POINTER(ctypes.c_ulong)), ctypes.POINTER(ctypes.c_uint)]
        x11.XFetchName.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(ctypes.c_char_p)]
        x11.XSetInputFocus.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
        x11.XRaiseWindow.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
        x11.XFree.argtypes = [ctypes.c_void_p]
        x11.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
        x11.XInternAtom.restype = ctypes.c_ulong
        x11.XGetWindowProperty.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_long, ctypes.c_long, ctypes.c_int, ctypes.c_ulong, ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_void_p)]
        title_atom = x11.XInternAtom(display, b'_NET_WM_NAME', 0)
        root, parent, children, count = ctypes.c_ulong(), ctypes.c_ulong(), ctypes.POINTER(ctypes.c_ulong)(), ctypes.c_uint()
        x11.XQueryTree(display, x11.XDefaultRootWindow(display), ctypes.byref(root), ctypes.byref(parent), ctypes.byref(children), ctypes.byref(count))
        found = False
        names = []
        for i in range(count.value):
            name = ctypes.c_char_p()
            x11.XFetchName(display, children[i], ctypes.byref(name))
            text = name.value.decode(errors='replace') if name.value else ''
            value, actual, fmt, length, after = ctypes.c_void_p(), ctypes.c_ulong(), ctypes.c_int(), ctypes.c_ulong(), ctypes.c_ulong()
            x11.XGetWindowProperty(display, children[i], title_atom, 0, 1024, 0, 0, ctypes.byref(actual), ctypes.byref(fmt), ctypes.byref(length), ctypes.byref(after), ctypes.byref(value))
            if value.value and length.value:
                text = ctypes.string_at(value, length.value).decode(errors='replace')
            if value.value:
                x11.XFree(value)
            names.append(text)
            geometry_root, x, y, width, height, border, depth = ctypes.c_ulong(), ctypes.c_int(), ctypes.c_int(), ctypes.c_uint(), ctypes.c_uint(), ctypes.c_uint(), ctypes.c_uint()
            x11.XGetGeometry.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_uint), ctypes.POINTER(ctypes.c_uint), ctypes.POINTER(ctypes.c_uint), ctypes.POINTER(ctypes.c_uint)]
            x11.XGetGeometry(display, children[i], ctypes.byref(geometry_root), ctypes.byref(x), ctypes.byref(y), ctypes.byref(width), ctypes.byref(height), ctypes.byref(border), ctypes.byref(depth))
            names[-1] += f' ({width.value}x{height.value})'
            if name.value:
                x11.XFree(name)
            if title in text and width.value > 500:
                x11.XRaiseWindow(display, children[i])
                x11.XSetInputFocus(display, children[i], 2, 0)
                x11.XFlush(display)
                found = True
                break
        x11.XFree(children)
        if not found:
            raise RuntimeError(f'Test window not found: {title}; available: {names}')
        time.sleep(0.1)
    keys = [x11.XKeysymToKeycode(display, x11.XStringToKeysym(k.encode())) for k in sys.argv[1:]]
    if not all(keys):
        raise ValueError("Unknown key")
    for key in keys:
        xtst.XTestFakeKeyEvent(display, key, 1, 0)
        x11.XFlush(display)
        time.sleep(0.03)
    for key in reversed(keys):
        xtst.XTestFakeKeyEvent(display, key, 0, 0)
        x11.XFlush(display)
        time.sleep(0.03)
finally:
    x11.XCloseDisplay(display)
