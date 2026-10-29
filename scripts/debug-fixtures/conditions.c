#include <string.h>
#include <stdio.h>
struct Slot { int state; };
__attribute__((noinline)) int visit(const char *key, struct Slot *slot) {
    return slot->state; /* breakpoint: line 5 */
}
int main(void) {
    struct Slot slot = {2};
    visit("tr-6c181547", &slot);
    visit("tr-d096a4e4", &slot);
    return 0;
}
