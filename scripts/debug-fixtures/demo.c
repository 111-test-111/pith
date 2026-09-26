#include <stdio.h>

static int xorshift32(int x) {
  x ^= x << 13; /* breakpoint: line 4 — x == 7 on first stop */
  x ^= x >> 17;
  x ^= x << 5;
  return x;
}

int main(void) {
  int x = 7;
  for (int i = 0; i < 3; i++) x = xorshift32(x);
  printf("%d\n", x);
  return 0;
}
