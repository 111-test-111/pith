#include <stdio.h>

int main(void) {
  int vals[64];
  for (int i = 0; i < 64; i++) vals[i] = i * 3;
  printf("%d\n", vals[63]); /* breakpoint: line 6 — vals fully populated, 64 children */
  return 0;
}
