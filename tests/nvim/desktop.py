"""Send native input to the isolated test desktop."""
import contextlib
import ctypes


class Desktop:
    def __init__(self, display):
        self.x11 = ctypes.CDLL('libX11.so.6')
        self.xtest = ctypes.CDLL('libXtst.so.6')
        self._bind()
        self.connection = self.x11.XOpenDisplay(display.encode())
        assert self.connection, 'Cannot connect to the isolated test display'

    def _bind(self):
        pointer, window = ctypes.c_void_p, ctypes.c_ulong
        ref = ctypes.POINTER
        signatures = {
            'XOpenDisplay': ([ctypes.c_char_p], pointer),
            'XDefaultRootWindow': ([pointer], window),
            'XQueryTree': ([pointer, window, ref(window), ref(window), ref(ref(window)), ref(ctypes.c_uint)], ctypes.c_int),
            'XFetchName': ([pointer, window, ref(pointer)], ctypes.c_int),
            'XInternAtom': ([pointer, ctypes.c_char_p, ctypes.c_int], window),
            'XGetWindowProperty': ([pointer, window, window, ctypes.c_long, ctypes.c_long, ctypes.c_int, window,
                                   ref(window), ref(ctypes.c_int), ref(window), ref(window), ref(pointer)], ctypes.c_int),
            'XGetGeometry': ([pointer, window, ref(window), ref(ctypes.c_int), ref(ctypes.c_int), *[ref(ctypes.c_uint)] * 4], ctypes.c_int),
            'XTranslateCoordinates': ([pointer, window, window, ctypes.c_int, ctypes.c_int,
                                       ref(ctypes.c_int), ref(ctypes.c_int), ref(window)], ctypes.c_int),
            'XFree': ([pointer], ctypes.c_int),
            'XRaiseWindow': ([pointer, window], ctypes.c_int),
            'XSetInputFocus': ([pointer, window, ctypes.c_int, window], ctypes.c_int),
            'XKeysymToKeycode': ([pointer, window], ctypes.c_ubyte),
            'XFlush': ([pointer], ctypes.c_int),
            'XCloseDisplay': ([pointer], ctypes.c_int),
            'XVendorRelease': ([pointer], ctypes.c_int),
        }
        for name, (arguments, result) in signatures.items():
            function = getattr(self.x11, name)
            function.argtypes, function.restype = arguments, result
        self.xtest.XTestFakeKeyEvent.argtypes = self.xtest.XTestFakeButtonEvent.argtypes = [pointer, ctypes.c_uint, ctypes.c_int, window]
        self.xtest.XTestFakeMotionEvent.argtypes = [pointer, ctypes.c_int, ctypes.c_int, ctypes.c_int, window]

    def title(self, window):
        atom = self.x11.XInternAtom(self.connection, b'_NET_WM_NAME', 0)
        kind, length, remaining = ctypes.c_ulong(), ctypes.c_ulong(), ctypes.c_ulong()
        size, value = ctypes.c_int(), ctypes.c_void_p()
        self.x11.XGetWindowProperty(self.connection, window, atom, 0, 1024, 0, 0, ctypes.byref(kind), ctypes.byref(size),
                                   ctypes.byref(length), ctypes.byref(remaining), ctypes.byref(value))
        if value.value:
            try: title = ctypes.string_at(value, length.value).decode(errors='replace')
            finally: self.x11.XFree(value)
            if title: return title
        value = ctypes.c_void_p()
        if not self.x11.XFetchName(self.connection, window, ctypes.byref(value)) or not value.value: return ''
        try: return ctypes.string_at(value).decode(errors='replace')
        finally: self.x11.XFree(value)

    def find(self, title, window=None, exact=False):
        window = window or self.x11.XDefaultRootWindow(self.connection)
        current = self.title(window)
        if (current == title if exact else title in current): return window
        root, parent = ctypes.c_ulong(), ctypes.c_ulong()
        children, count = ctypes.POINTER(ctypes.c_ulong)(), ctypes.c_uint()
        if not self.x11.XQueryTree(self.connection, window, ctypes.byref(root), ctypes.byref(parent), ctypes.byref(children), ctypes.byref(count)): return None
        try: items = [children[index] for index in range(count.value)]
        finally:
            if children: self.x11.XFree(children)
        return next((found for child in items if (found := self.find(title, child, exact))), None)

    def focus(self, window):
        self.x11.XRaiseWindow(self.connection, window)
        self.x11.XSetInputFocus(self.connection, window, 1, 0)
        self.x11.XFlush(self.connection)

    def _key_event(self, symbol, pressed):
        code = self.x11.XKeysymToKeycode(self.connection, symbol)
        self.xtest.XTestFakeKeyEvent(self.connection, code, int(pressed), 0)

    @contextlib.contextmanager
    def _modifiers(self, symbols):
        for symbol in symbols: self._key_event(symbol, True)
        try: yield
        finally:
            for symbol in reversed(symbols): self._key_event(symbol, False)
            self.x11.XFlush(self.connection)

    def key(self, window, symbol, modifiers=()):
        self.focus(window)
        with self._modifiers(modifiers):
            self._key_event(symbol, True)
            self._key_event(symbol, False)

    def _geometry(self, window):
        root, child = ctypes.c_ulong(), ctypes.c_ulong()
        left, top = ctypes.c_int(), ctypes.c_int()
        width, height, border, depth = [ctypes.c_uint() for _ in range(4)]
        assert self.x11.XGetGeometry(self.connection, window, ctypes.byref(root), ctypes.byref(left), ctypes.byref(top),
                                    ctypes.byref(width), ctypes.byref(height), ctypes.byref(border), ctypes.byref(depth))
        assert self.x11.XTranslateCoordinates(self.connection, window, self.x11.XDefaultRootWindow(self.connection), 0, 0,
                                              ctypes.byref(left), ctypes.byref(top), ctypes.byref(child))
        return left.value, top.value, width.value, height.value

    def click(self, window, column, row, columns, lines, modifiers=()):
        left, top, width, height = self._geometry(window)
        x, y = left + int((column - .5) * width / columns), top + int((row - .5) * height / lines)
        self.focus(window)
        with self._modifiers(modifiers):
            self.xtest.XTestFakeMotionEvent(self.connection, -1, x, y, 0)
            self.xtest.XTestFakeButtonEvent(self.connection, 1, 1, 0)
            self.xtest.XTestFakeButtonEvent(self.connection, 1, 0, 0)

    def vendor_release(self):
        return self.x11.XVendorRelease(self.connection)

    def close(self):
        if self.connection:
            self.x11.XCloseDisplay(self.connection)
            self.connection = None

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
