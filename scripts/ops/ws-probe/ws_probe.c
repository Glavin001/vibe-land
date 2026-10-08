// One round trip to WindowServer: list the on-screen windows. If WindowServer
// is starved (2026-10-08: GPU compute held it for 40 s, its watchdog killed it
// and logged the owner out), this call blocks. Prints the round trip in ms.
#include <CoreGraphics/CoreGraphics.h>
#include <stdio.h>
#include <time.h>
int main(void) {
  struct timespec a, b;
  clock_gettime(CLOCK_MONOTONIC, &a);
  CFArrayRef list = CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly, kCGNullWindowID);
  clock_gettime(CLOCK_MONOTONIC, &b);
  if (list) CFRelease(list);
  printf("%.1f\n", (b.tv_sec - a.tv_sec) * 1e3 + (b.tv_nsec - a.tv_nsec) / 1e6);
  return list ? 0 : 1;
}
