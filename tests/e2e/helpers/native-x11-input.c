#include <X11/Xlib.h>
#include <X11/keysym.h>
#include <X11/extensions/XTest.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static int send_key(Display *display, const char *name) {
  KeySym symbol = XStringToKeysym(name);
  if (symbol == NoSymbol) {
    fprintf(stderr, "Unknown key: %s\n", name);
    return 1;
  }
  KeyCode code = XKeysymToKeycode(display, symbol);
  XTestFakeKeyEvent(display, code, True, CurrentTime);
  XTestFakeKeyEvent(display, code, False, CurrentTime);
  XFlush(display);
  usleep(120000);
  return 0;
}

int main(int argc, char **argv) {
  Display *display = XOpenDisplay(NULL);
  if (!display) {
    fprintf(stderr, "Could not connect to the X11 display.\n");
    return 2;
  }

  int result = 0;
  if (argc == 5 && strcmp(argv[1], "click") == 0) {
    int x = atoi(argv[2]);
    int y = atoi(argv[3]);
    int button = atoi(argv[4]);
    XTestFakeMotionEvent(display, DefaultScreen(display), x, y, CurrentTime);
    XTestFakeButtonEvent(display, button, True, CurrentTime);
    XTestFakeButtonEvent(display, button, False, CurrentTime);
    XFlush(display);
    usleep(350000);
  } else if (argc >= 3 && strcmp(argv[1], "keys") == 0) {
    for (int i = 2; i < argc && result == 0; i++) result = send_key(display, argv[i]);
  } else {
    fprintf(stderr, "Usage: native-x11-input click X Y BUTTON | keys KeySym...\n");
    result = 1;
  }

  XCloseDisplay(display);
  return result;
}
