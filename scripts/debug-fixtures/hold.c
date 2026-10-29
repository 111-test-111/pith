#include <stdio.h>
#include <unistd.h>

typedef struct Node {
    int value;
    struct Node *next;
} Node;

/* Deliberately NULL: fixture for evaluate on a NULL struct pointer. */
static Node *cursor = 0;

int main(void) {
    printf("holding\n");
    fflush(stdout);
    for (int i = 0; i < 60; i++) {
        sleep(1);
    }
    return cursor ? cursor->value : 0;
}
